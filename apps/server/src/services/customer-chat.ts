// 客服聊天服务 —— 匿名会话 + 知识库检索 + 工具调用
//
// V3 重构：LLM 质量体系
//   1. 确定性上下文协议（每条 KB chunk 标记来源 + 不可修改）
//   2. Prompt 硬约束化（禁止模糊词，明确的禁止行为清单）
//   3. 结构化 JSON 输出（Zod 校验，消除正则解析脆弱性）
//   4. 5 层校验管线（格式 → Schema → 禁止词 → KB命中率 → 固定话术）
//   5. 失败降级链路（主模型重试 → 备选模型 → 确定性 fallback）
//   6. 数据回收（失败样本落盘 JSONL）
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel, listProviders } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { logger } from "@agentforge/logger";
import { toolRegistry } from "../tools/registry.js";
import { intentDetector } from "./intent-detector.js";
import { MemoryEngine } from "./memory-engine.js";
import { z } from "zod";
import { extractJSONFromLLMResponse } from "../lib/json-utils.js";

const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";
const MAX_HISTORY_MESSAGES = 20;
const MAX_TOOL_ROUNDS = 3;

// 工作时间
const SERVICE_HOURS_START = parseInt(process.env.CS_SERVICE_HOURS_START || "9", 10);
const SERVICE_HOURS_END = parseInt(process.env.CS_SERVICE_HOURS_END || "18", 10);
const SERVICE_DAYS = (process.env.CS_SERVICE_DAYS || "1,2,3,4,5").split(",").map(Number);

// ═══════════════════════════════════════════════════════
// 固定话术（确定性，LLM 不能改）
// ═══════════════════════════════════════════════════════
export const SORRY_TEMPLATE = "抱歉，我目前没有找到相关信息，建议您联系人工客服获取帮助。";
export const FALLBACK_PREFIX = "以下是可能相关的知识库内容，如需更多帮助请联系人工客服：\n\n";

// ═══════════════════════════════════════════════════════
// Zod Schema：LLM 输出的结构化 JSON
// ═══════════════════════════════════════════════════════
export const ChatResponseSchema = z.object({
  answer: z.string().min(1).max(2000),
  suggestions: z.array(z.string().max(50)).max(3).default([]),
});

type ChatResponse = z.infer<typeof ChatResponseSchema>;

// ═══════════════════════════════════════════════════════
// 禁止行为扫描列表（Layer 3）
// ═══════════════════════════════════════════════════════
export const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /根据(我司|公司|平台)规定/g, label: "虚假权威引用" },
  { pattern: /经查询[^，。]*[，。]/g, label: "虚假查询陈述" },
  { pattern: /可能是(因为|由于)/g, label: "无依据推测原因" },
  { pattern: /您的(订单|物流|快递)[^，。]{0,10}(可能|应该)/g, label: "推测客户信息" },
  { pattern: /建议您(自行|自己)[^，。]*[，。]/g, label: "推卸责任式建议" },
];

// ═══════════════════════════════════════════════════════
// System Prompt（硬约束版）
// ═══════════════════════════════════════════════════════
const CUSTOMER_SERVICE_PROMPT = `你是一个专业的客户服务代表。你的回答必须严格基于下方提供的【知识库参考资料】。

## 核心规则（违反任何一条都是错误）

### 信息来源
1. 只从下方【知识库参考资料】中引用事实性信息。参考资料中的每条数据都标记了"不可修改"。
2. 当用户问题的关键词在参考资料中均未出现时，你必须输出固定话术：${SORRY_TEMPLATE}
3. 你不得使用参考资料之外的任何事实性陈述，不得凭"常识"补充。

### 绝对禁止
禁止编造退货政策、价格、时间、流程、运费等任何事实性信息。
禁止输出"根据公司规定""经查询""据我了解"等暗示权威来源的说法。
禁止在参考资料未提供的情况下给出具体数字（天数、金额、比例、距离）。
禁止推测客户问题的原因。
禁止对客户个人信息做任何推断。
禁止输出<think>或<thinking>标签。

### 输出格式
你必须输出一个严格的 JSON 对象，不要任何前言、后记、Markdown 标记：
{"answer": "你的回答文本", "suggestions": ["追问1", "追问2"]}

- answer: 给客户的回答，1-2000 字符。如果无法回答则写固定话术"${SORRY_TEMPLATE}"。
- suggestions: 2-3 个客户可能关心的后续问题，每个不超过 50 字符。无法生成时写空数组 []。

{memory_context}
{knowledge_context}`;

const MEMORY_PROMPT_PREFIX = "\n\n# 客户信息（来自历史对话记忆）\n以下是你了解的该客户的信息：\n";

// ═══════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════
export interface KnowledgeChunkResult {
  content: string;
  score: number;
  docTitle: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  layer: number; // 哪一层失败了
}

interface EvalRecord {
  timestamp: string;
  sessionId: string | null;
  userMessage: string;
  kbAvailable: boolean;
  rawResponse: string;
  finalOutput: string | null;
  validationErrors: string[];
  retryCount: number;
  modelUsed: string;
  fallbackUsed: boolean;
}

// ═══════════════════════════════════════════════════════
// 主类
// ═══════════════════════════════════════════════════════
export class CustomerChatService {
  private modelId: string | null;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
  }

  // ── 会话管理 ──
  private async getOrCreateConversation(sessionId: string | null) {
    if (sessionId) {
      const existing = await prisma.conversation.findFirst({
        where: { sessionId, type: "customer_service" },
      });
      if (existing) return existing;
    }
    const conversation = await prisma.conversation.create({
      data: {
        id: randomUUID(),
        title: "客服会话",
        userId: CUSTOMER_USER_ID,
        type: "customer_service",
        sessionId,
      },
    });
    return conversation;
  }

  // ── 知识库搜索（含来源标记） ──
  private async fetchKnowledge(userMessage: string): Promise<{
    context: string;
    results: KnowledgeChunkResult[];
  }> {
    try {
      const { KnowledgeService } = await import("./knowledge.js");
      const service = new KnowledgeService();
      const results = await service.search(userMessage, undefined, 3);

      if (!results.length) return { context: "", results: [] };

      const lines = ["【知识库参考资料 —— 以下每条数据均来自知识库，不可修改】"];
      const scoredResults: KnowledgeChunkResult[] = [];
      results.forEach((r, i) => {
        // 每条数据带来源标记：文档名 + 不可修改 + 编号
        const sourceTag = `[来源: ${r.docTitle || r.docId} | 不可修改 | 编号: KB-${i + 1}]`;
        lines.push(`${sourceTag}\n${r.content}`);
        scoredResults.push({
          content: r.content.slice(0, 300),
          score: r.score,
          docTitle: r.docTitle || r.docId,
        });
      });
      return {
        context: "\n\n" + lines.join("\n\n---\n\n"),
        results: scoredResults,
      };
    } catch (e) {
      logger.warn(e, "Customer chat knowledge search failed");
      return { context: "", results: [] };
    }
  }

  // ── 记忆注入 ──
  private async injectMemories(
    userMessage: string,
    sessionId: string | null,
  ): Promise<[string, string[]]> {
    if (!sessionId) return ["", []];
    try {
      const engine = new MemoryEngine();
      const memories = await engine.search(userMessage, CUSTOMER_USER_ID, 5, sessionId);
      const relevant = memories.filter((m) => m.score > 0.3);
      if (relevant.length > 0) {
        const memoryText = relevant.map((m) => `- ${m.content}`).join("\n");
        return [MEMORY_PROMPT_PREFIX + memoryText, relevant.map((m) => m.content)];
      }
    } catch (e) {
      logger.warn(e, "Customer memory injection failed");
    }
    return ["", []];
  }

  // ── 5 层校验管线 ──
  private validateResponse(rawText: string, knowledgeChunks: string[]): ValidationResult {
    // Layer 1: JSON 可解析
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJSONFromLLMResponse(rawText));
    } catch {
      return { valid: false, errors: ["Layer1: JSON 不可解析"], layer: 1 };
    }

    // Layer 2: Schema 校验
    const schemaResult = ChatResponseSchema.safeParse(parsed);
    if (!schemaResult.success) {
      const issues = schemaResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      return { valid: false, errors: [`Layer2: Schema校验失败 - ${issues.join("; ")}`], layer: 2 };
    }

    const data = schemaResult.data;

    // Layer 3: 禁止行为扫描
    const forbiddenHits: string[] = [];
    for (const { pattern, label } of FORBIDDEN_PATTERNS) {
      pattern.lastIndex = 0; // 重置 regex 状态
      if (pattern.test(data.answer)) {
        forbiddenHits.push(label);
      }
    }
    if (forbiddenHits.length > 0) {
      return {
        valid: false,
        errors: [`Layer3: 命中禁止行为 - ${forbiddenHits.join(", ")}`],
        layer: 3,
      };
    }

    // Layer 4: KB 命中率校验（软告警，不阻止）
    const layer4Errors: string[] = [];
    if (knowledgeChunks.length > 0) {
      const answerLower = data.answer.toLowerCase();
      const hitCount = knowledgeChunks.filter((chunk) => {
        // 取 chunk 中最长的词（>2 字符）作为关键实体
        const keywords = chunk.match(/[一-鿿\w]{3,}/g) || [];
        return keywords.some((kw) => answerLower.includes(kw.toLowerCase()));
      }).length;
      const hitRate = knowledgeChunks.length > 0 ? hitCount / knowledgeChunks.length : 0;
      if (hitRate < 0.5 && !data.answer.includes(SORRY_TEMPLATE)) {
        layer4Errors.push(`Layer4: KB命中率过低 (${(hitRate * 100).toFixed(0)}%)`);
        // Layer 4 只是软告警，不影响 valid
      }
    }

    // Layer 5: 固定话术检查（KB 为空但没使用 SORRY_TEMPLATE）
    if (knowledgeChunks.length === 0 && data.answer !== SORRY_TEMPLATE) {
      // 检查是否在编造
      if (data.answer.length > SORRY_TEMPLATE.length + 20) {
        return {
          valid: false,
          errors: ["Layer5: KB上下文为空但未使用SORRY_TEMPLATE固定话术，疑似编造"],
          layer: 5,
        };
      }
    }

    return { valid: true, errors: layer4Errors, layer: 0 };
  }

  // ── LLM 单次调用（非流式，用于结构化输出） ──
  private async callLLM(
    messages: ChatMessage[],
    model: string,
    providerName: string,
    systemPrompt: string,
    temperature: number,
  ): Promise<string> {
    const provider = getProvider(providerName);
    const result = await provider.chatSync(
      messages,
      model,
      systemPrompt,
      temperature,
      1024,
      true, // jsonMode — provider handles OpenAI's response_format or DeepSeek's prompt suffix
    );
    return result.content;
  }

  // ── 带重试的 LLM 调用 ──
  private async callLLMWithRetry(
    messages: ChatMessage[],
    systemPrompt: string,
    knowledgeChunks: string[],
  ): Promise<{ response: ChatResponse; evalRecord: Partial<EvalRecord> }> {
    const [primaryProvider, primaryModel] = resolveModel(this.modelId);
    const evalRecord: Partial<EvalRecord> = {
      retryCount: 0,
      modelUsed: `${primaryProvider}:${primaryModel}`,
      fallbackUsed: false,
      validationErrors: [],
    };

    // 温度递减序列
    const temperatures = [0.3, 0.1, 0.0];

    // ── 主模型重试（最多 2 次 = 3 次调用） ──
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rawText = await this.callLLM(
          messages, primaryModel, primaryProvider,
          systemPrompt, temperatures[attempt] || 0,
        );
        evalRecord.rawResponse = rawText;

        const validation = this.validateResponse(rawText, knowledgeChunks);
        if (validation.valid) {
          // Layer 4 软告警也记录但不阻止
          if (validation.errors.length > 0) {
            evalRecord.validationErrors = validation.errors;
          }
          const parsed = this.parseResponse(rawText);
          evalRecord.finalOutput = parsed?.answer || "";
          return { response: parsed!, evalRecord };
        }

        logger.warn(
          { attempt: attempt + 1, errors: validation.errors },
          "LLM response validation failed, retrying",
        );
        evalRecord.validationErrors = validation.errors;
        evalRecord.retryCount = attempt + 1;

        // Layer 1-3 失败才重试，Layer 5 也重试
        // 如果是 Layer 4 软告警，直接通过（上面已处理）
      } catch (e) {
        logger.warn(e, `LLM call failed (attempt ${attempt + 1})`);
        evalRecord.retryCount = attempt + 1;
      }
    }

    // ── 备选模型降级（1 次） ──
    const allProviders = listProviders();
    const fallbackProvider = allProviders.find((p) => p.type !== primaryProvider);
    if (fallbackProvider) {
      const fallbackModel = fallbackProvider.models[0]?.id || primaryModel;
      try {
        logger.info({ provider: fallbackProvider.type, model: fallbackModel }, "Falling back to alternative model");
        const rawText = await this.callLLM(
          messages, fallbackModel, fallbackProvider.type,
          systemPrompt, 0.0,
        );
        evalRecord.rawResponse = rawText;
        evalRecord.modelUsed = `${fallbackProvider.type}:${fallbackModel}`;
        evalRecord.fallbackUsed = true;

        const validation = this.validateResponse(rawText, knowledgeChunks);
        if (validation.valid) {
          if (validation.errors.length > 0) {
            evalRecord.validationErrors = validation.errors;
          }
          const parsed = this.parseResponse(rawText);
          evalRecord.finalOutput = parsed?.answer || "";
          return { response: parsed!, evalRecord };
        }
        evalRecord.validationErrors = validation.errors;
      } catch (e) {
        logger.warn(e, "Fallback model also failed");
      }
    }

    // ── 确定性 fallback ──
    throw new Error("ALL_MODELS_FAILED");
  }

  // ── 解析 LLM 响应为 ChatResponse ──
  private parseResponse(rawText: string): ChatResponse | null {
    try {
      const parsed = JSON.parse(extractJSONFromLLMResponse(rawText));
      const result = ChatResponseSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  // ── 确定性 fallback 构建 ──
  private buildFallbackResponse(knowledgeResults: KnowledgeChunkResult[]): ChatResponse {
    if (knowledgeResults.length > 0) {
      const kbText = knowledgeResults.map((r) => r.content).join("\n\n");
      return {
        answer: FALLBACK_PREFIX + kbText,
        suggestions: [],
      };
    }
    return {
      answer: SORRY_TEMPLATE,
      suggestions: [],
    };
  }

  // ── 数据回收：失败样本落盘 ──
  private async logEvalRecord(record: EvalRecord): Promise<void> {
    try {
      const fs = await import("fs/promises");
      const path = await import("path");
      const logDir = path.join(process.cwd(), "logs", "eval");
      await fs.mkdir(logDir, { recursive: true });
      const logFile = path.join(logDir, `cs-eval-${new Date().toISOString().split("T")[0]}.jsonl`);
      const line = JSON.stringify(record) + "\n";
      await fs.appendFile(logFile, line, "utf-8");
    } catch {
      // 日志失败不影响主流程
    }
  }

  // ── 工作时间检查 ──
  private isWithinServiceHours(): boolean {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const hour = now.getHours();
    const adjustedDay = dayOfWeek === 0 ? 7 : dayOfWeek;
    if (!SERVICE_DAYS.includes(adjustedDay)) return false;
    if (hour < SERVICE_HOURS_START || hour >= SERVICE_HOURS_END) return false;
    return true;
  }

  // ── 主流程 ──
  async *streamChat(
    sessionId: string | null,
    userMessage: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const conversation = await this.getOrCreateConversation(sessionId);
    const [providerName, resolvedModel] = resolveModel(this.modelId);

    // 意图识别
    const { intent } = intentDetector.detect(userMessage);
    const withinHours = this.isWithinServiceHours();

    // 加载历史
    const history = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: MAX_HISTORY_MESSAGES,
    });
    const reversed = history.reverse();

    // 保存用户消息
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "user",
        content: userMessage,
        model: resolvedModel,
      },
    });

    if (intent !== "其他咨询") {
      try {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { intent },
        });
      } catch { /* 字段可能未迁移 */ }
    }

    // 知识库搜索
    const { context: knowledgeContext, results: knowledgeResults } =
      await this.fetchKnowledge(userMessage);

    // 构建消息列表
    const conversationMessages: ChatMessage[] = reversed.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    conversationMessages.push({ role: "user", content: userMessage });

    // 构建 system prompt
    const hoursNote = withinHours
      ? ""
      : "\n\n注意：当前为非工作时间（工作日 9:00-18:00），请在回复开头礼貌提醒客户。";
    let systemPrompt = CUSTOMER_SERVICE_PROMPT
      .replace("{knowledge_context}", knowledgeContext + hoursNote)
      .replace("{memory_context}", "");

    // 注入记忆
    const [memoryContext, injectedMemories] = await this.injectMemories(
      userMessage,
      conversation.sessionId,
    );
    systemPrompt = systemPrompt.replace("{memory_context}", memoryContext);

    const assistantMsgId = randomUUID();

    // 发送 meta
    yield {
      type: "meta",
      message_id: assistantMsgId,
      session_id: conversation.sessionId,
      model: resolvedModel,
      provider: providerName,
      knowledge: knowledgeResults,
      intent,
      within_service_hours: withinHours,
      memory_count: injectedMemories.length,
    };

    // 知识库 chunks 文本（用于校验）
    const kbChunks = knowledgeResults.map((r) => r.content);

    // ── LLM 调用（含重试 + 降级 + fallback） ──
    let chatResponse: ChatResponse;
    let evalRecord: EvalRecord = {
      timestamp: new Date().toISOString(),
      sessionId: conversation.sessionId,
      userMessage: userMessage.slice(0, 200),
      kbAvailable: knowledgeResults.length > 0,
      rawResponse: "",
      finalOutput: null,
      validationErrors: [],
      retryCount: 0,
      modelUsed: `${providerName}:${resolvedModel}`,
      fallbackUsed: false,
    };

    try {
      const result = await this.callLLMWithRetry(
        conversationMessages,
        systemPrompt,
        kbChunks,
      );
      chatResponse = result.response;
      evalRecord = { ...evalRecord, ...result.evalRecord };
    } catch {
      // 所有模型都失败 → 确定性 fallback
      logger.warn("All LLM models failed, using deterministic fallback");
      chatResponse = this.buildFallbackResponse(knowledgeResults);
      evalRecord.fallbackUsed = true;
      evalRecord.finalOutput = chatResponse.answer;
    }

    // 记录数据回收
    await this.logEvalRecord(evalRecord);

    // ── 输出 answer（逐字符流式，保持打字动画体验） ──
    const answer = chatResponse.answer;
    for (const char of answer) {
      yield {
        type: "token",
        content: char,
        message_id: assistantMsgId,
      };
    }

    // ── 发送 done ──
    yield {
      type: "done",
      message_id: assistantMsgId,
      usage: {},
      suggestions: chatResponse.suggestions.length > 0 ? chatResponse.suggestions : undefined,
      memory: {
        injected: injectedMemories.length,
        extracted: 0,
      },
      validated: evalRecord.validationErrors.length === 0,
      fallback_used: evalRecord.fallbackUsed,
    };

    // ── 保存助手消息 ──
    await prisma.message.create({
      data: {
        id: assistantMsgId,
        conversationId: conversation.id,
        role: "assistant",
        content: answer,
        model: resolvedModel,
      },
    });

    // ── 提取记忆 ──
    if (conversation.sessionId) {
      try {
        const engine = new MemoryEngine();
        const allMessages = [
          ...reversed.map((m) => ({ role: m.role, content: m.content })),
          { role: "user" as const, content: userMessage },
          { role: "assistant" as const, content: answer },
        ];
        const extracted = await engine.extractAndStore(
          allMessages,
          CUSTOMER_USER_ID,
          conversation.id,
          providerName,
          conversation.sessionId,
        );
        if (extracted.length > 0) {
          logger.info({ count: extracted.length, sessionId: conversation.sessionId }, "Customer memories extracted");
        }
      } catch (e) {
        logger.warn(e, "Customer memory extraction failed");
      }
    }
  }
}
