// BusinessAgent —— 业务咨询 RAG 管线
// 处理退货政策、物流规则、会员权益等需要知识库的业务问题
//
// 流程：
//   KB 搜索 → 阈值门控(score<0.6→SORRY) → 记忆注入 → LLM 生成
//   → 5 层校验 → 重试/降级/fallback
//
// 从 CustomerChatService 中提取的完整 RAG 管线

import { randomUUID } from "crypto";
import { prisma } from "../../db.js";
import {
  getProvider,
  resolveModel,
  listProviders,
} from "../../providers/registry.js";
import type { ChatMessage } from "../../providers/types.js";
import { logger } from "@agentforge/logger";
import { extractJSONFromLLMResponse } from "../../lib/json-utils.js";
import { MemoryEngine } from "../memory-engine.js";
import type {
  RouteAgent,
  RouteContext,
  RouteStreamEvent,
  KnowledgeChunkResult,
  EvalRecord,
} from "./types.js";
import {
  SORRY_TEMPLATE,
  FALLBACK_PREFIX,
  ChatResponseSchema,
  validateBusinessResponse,
  parseChatResponse,
  type ChatResponse,
} from "./validation.js";
import {
  getCitationVerifier,
  type CitationReport,
} from "./citation-verifier.js";

// ── 阈值门控配置 ──

const KB_SCORE_THRESHOLD = parseFloat(
  process.env.CS_KB_SCORE_THRESHOLD || "0.6",
);

// ── Business System Prompt（硬约束版） ──

const BUSINESS_SYSTEM_PROMPT = `你是 AgentForge 平台的智能客服助手，负责回答业务事实类问题。

## 核心规则（违反任何一条都是错误）

### 信息来源
1. 你只能从下方【知识库参考资料】中引用信息。参考资料中的每条数据都标记了"不可修改"。
2. 当参考资料中没有相关信息时，你必须输出固定话术："${SORRY_TEMPLATE}"
3. 不得在回复中编造任何业务政策、价格、流程等事实信息。

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

- answer: 给客户的回答，1-2000 字符。无法回答时写固定话术"${SORRY_TEMPLATE}"。
- suggestions: 2-3 个客户可能关心的后续问题，每个不超过 50 字符。无法生成时写空数组 []。

{memory_context}
{knowledge_context}`;

const MEMORY_PROMPT_PREFIX =
  "\n\n# 客户信息（来自历史对话记忆）\n以下是你了解的该客户的信息：\n";

const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";

// ═══════════════════════════════════════════════════════
// BusinessAgent
// ═══════════════════════════════════════════════════════

export class BusinessAgent implements RouteAgent {
  readonly route = "BUSINESS" as const;
  private modelId: string | null;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
  }

  async *execute(context: RouteContext): AsyncGenerator<RouteStreamEvent> {
    const {
      conversationId,
      sessionId,
      userMessage,
      knowledgeResults,
      knowledgeContext,
      kbChunks,
      injectedMemories,
      memoryContext,
      resolvedModel,
      providerName,
      withinServiceHours,
      assistantMsgId,
      intent,
    } = context;

    // ── 阈值门控：top result score < 阈值 → 直接返回 SORRY_TEMPLATE ──
    if (
      knowledgeResults.length === 0 ||
      knowledgeResults[0].score < KB_SCORE_THRESHOLD
    ) {
      yield* this.streamFallback(
        assistantMsgId,
        sessionId,
        resolvedModel,
        providerName,
        withinServiceHours,
        intent,
        buildFallbackResponse(knowledgeResults),
        injectedMemories.length,
        true,
      );
      return;
    }

    // ── 构建消息列表 ──
    const conversationMessages: ChatMessage[] = [
      ...context.history,
      { role: "user", content: userMessage },
    ];

    // ── 构建 system prompt ──
    const hoursNote = withinServiceHours
      ? ""
      : "\n\n注意：当前为非工作时间（工作日 9:00-18:00），请在回复开头礼貌提醒客户。";
    const systemPrompt = BUSINESS_SYSTEM_PROMPT.replace(
      "{knowledge_context}",
      knowledgeContext + hoursNote,
    ).replace("{memory_context}", memoryContext);

    // ── LLM 调用（含重试 + 降级 + fallback） ──
    let chatResponse: ChatResponse;
    let evalRecord: EvalRecord = {
      timestamp: new Date().toISOString(),
      sessionId,
      userMessage: userMessage.slice(0, 200),
      kbAvailable: knowledgeResults.length > 0,
      rawResponse: "",
      finalOutput: null,
      validationErrors: [],
      retryCount: 0,
      modelUsed: `${providerName}:${resolvedModel}`,
      fallbackUsed: false,
      route: "BUSINESS",
    };

    try {
      const result = await callLLMWithRetry(
        conversationMessages,
        systemPrompt,
        kbChunks,
        this.modelId,
      );
      chatResponse = result.response;
      evalRecord = { ...evalRecord, ...result.evalRecord };
    } catch {
      logger.warn("All LLM models failed, using deterministic fallback");
      chatResponse = buildFallbackResponse(knowledgeResults);
      evalRecord.fallbackUsed = true;
      evalRecord.finalOutput = chatResponse.answer;
    }

    // 记录数据回收
    await logEvalRecord(evalRecord);

    // ── 发送 meta ──
    yield {
      type: "meta",
      message_id: assistantMsgId,
      session_id: sessionId,
      model: resolvedModel,
      provider: providerName,
      knowledge: knowledgeResults,
      intent,
      within_service_hours: withinServiceHours,
      memory_count: injectedMemories.length,
      route: "BUSINESS",
    };

    // ── 逐字符流式输出 answer ──
    for (const char of chatResponse.answer) {
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
      suggestions:
        chatResponse.suggestions.length > 0
          ? chatResponse.suggestions
          : undefined,
      memory: {
        injected: injectedMemories.length,
        extracted: 0,
      },
      validated: evalRecord.validationErrors.length === 0,
      fallback_used: evalRecord.fallbackUsed,
      route: "BUSINESS",
    };
  }

  // ── 流式输��� fallback 响应 ──
  private async *streamFallback(
    assistantMsgId: string,
    sessionId: string | null,
    model: string,
    provider: string,
    withinHours: boolean,
    intent: string,
    response: ChatResponse,
    memoryCount: number,
    fallbackUsed: boolean,
  ): AsyncGenerator<RouteStreamEvent> {
    yield {
      type: "meta",
      message_id: assistantMsgId,
      session_id: sessionId,
      model,
      provider,
      knowledge: [],
      intent,
      within_service_hours: withinHours,
      memory_count: memoryCount,
      route: "BUSINESS",
    };

    for (const char of response.answer) {
      yield {
        type: "token",
        content: char,
        message_id: assistantMsgId,
      };
    }

    yield {
      type: "done",
      message_id: assistantMsgId,
      usage: {},
      suggestions: undefined,
      memory: { injected: memoryCount, extracted: 0 },
      validated: true,
      fallback_used: fallbackUsed,
      route: "BUSINESS",
    };
  }
}

// ═══════════════════════════════════════════════════════
// 独立函数（从 CustomerChatService 提取，不依赖实例状态）
// ═══════════════════════════════════════════════════════

function buildFallbackResponse(
  knowledgeResults: KnowledgeChunkResult[],
): ChatResponse {
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

async function callLLMWithRetry(
  messages: ChatMessage[],
  systemPrompt: string,
  knowledgeChunks: string[],
  modelId: string | null,
): Promise<{ response: ChatResponse; evalRecord: Partial<EvalRecord> }> {
  const [primaryProvider, primaryModel] = resolveModel(modelId);
  const evalRecord: Partial<EvalRecord> = {
    retryCount: 0,
    modelUsed: `${primaryProvider}:${primaryModel}`,
    fallbackUsed: false,
    validationErrors: [],
  };

  const temperatures = [0.3, 0.1, 0.0];
  const citationVerifier = getCitationVerifier();

  // ── 主模型重试（3 次） ──
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const rawText = await callLLM(
        messages,
        primaryModel,
        primaryProvider,
        systemPrompt,
        temperatures[attempt] || 0,
      );
      evalRecord.rawResponse = rawText;

      // 先解析以获取 answer 文本
      const parsed = parseChatResponse(rawText);
      let citationReport: CitationReport | undefined;

      // 对成功的解析结果运行 Citation 引证校验
      if (parsed && knowledgeChunks.length > 0 && parsed.answer !== SORRY_TEMPLATE) {
        try {
          citationReport = await citationVerifier.verify(
            parsed.answer,
            knowledgeChunks,
          );
          evalRecord.citation = {
            level: citationReport.level,
            coverageRate: citationReport.coverageRate,
            avgScore: citationReport.avgScore,
            uncitedCount: citationReport.sentences.filter(
              (s) => s.isFactual && s.status === "uncited",
            ).length,
          };
        } catch {
          // citation 校验失败不影响主流程
        }
      }

      const validation = validateBusinessResponse(
        rawText,
        knowledgeChunks,
        citationReport,
      );

      if (validation.valid) {
        if (validation.errors.length > 0) {
          evalRecord.validationErrors = validation.errors;
        }
        evalRecord.finalOutput = parsed?.answer || "";
        return { response: parsed!, evalRecord };
      }

      logger.warn(
        { attempt: attempt + 1, errors: validation.errors },
        "BusinessAgent LLM validation failed, retrying",
      );
      evalRecord.validationErrors = validation.errors;
      evalRecord.retryCount = attempt + 1;
    } catch (e) {
      logger.warn(e, `BusinessAgent LLM call failed (attempt ${attempt + 1})`);
      evalRecord.retryCount = attempt + 1;
    }
  }

  // ── 备选模型降级（1 次） ──
  const allProviders = listProviders();
  const fallbackProvider = allProviders.find(
    (p) => p.type !== primaryProvider,
  );
  if (fallbackProvider) {
    const fallbackModel = fallbackProvider.models[0]?.id || primaryModel;
    try {
      logger.info(
        { provider: fallbackProvider.type, model: fallbackModel },
        "Falling back to alternative model",
      );
      const rawText = await callLLM(
        messages,
        fallbackModel,
        fallbackProvider.type,
        systemPrompt,
        0.0,
      );
      evalRecord.rawResponse = rawText;
      evalRecord.modelUsed = `${fallbackProvider.type}:${fallbackModel}`;
      evalRecord.fallbackUsed = true;

      const parsed = parseChatResponse(rawText);
      let citationReport: CitationReport | undefined;
      if (parsed && knowledgeChunks.length > 0 && parsed.answer !== SORRY_TEMPLATE) {
        try {
          citationReport = await citationVerifier.verify(
            parsed.answer,
            knowledgeChunks,
          );
          evalRecord.citation = {
            level: citationReport.level,
            coverageRate: citationReport.coverageRate,
            avgScore: citationReport.avgScore,
            uncitedCount: citationReport.sentences.filter(
              (s) => s.isFactual && s.status === "uncited",
            ).length,
          };
        } catch {
          // citation 校验失败不影响主流程
        }
      }

      const validation = validateBusinessResponse(
        rawText,
        knowledgeChunks,
        citationReport,
      );

      if (validation.valid) {
        if (validation.errors.length > 0) {
          evalRecord.validationErrors = validation.errors;
        }
        evalRecord.finalOutput = parsed?.answer || "";
        return { response: parsed!, evalRecord };
      }
      evalRecord.validationErrors = validation.errors;
    } catch (e) {
      logger.warn(e, "Fallback model also failed");
    }
  }

  throw new Error("ALL_MODELS_FAILED");
}

async function callLLM(
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
    true, // jsonMode
  );
  return result.content;
}

async function logEvalRecord(record: EvalRecord): Promise<void> {
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const logDir = path.join(process.cwd(), "logs", "eval");
    await fs.mkdir(logDir, { recursive: true });
    const logFile = path.join(
      logDir,
      `cs-eval-${new Date().toISOString().split("T")[0]}.jsonl`,
    );
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(logFile, line, "utf-8");
  } catch {
    // 日志失败不影响主流程
  }
}

// ═══════════════════════════════════════════════════════
// KB 搜索工具函数
// ═══════════════════════════════════════════════════════

export async function fetchKnowledge(userMessage: string): Promise<{
  context: string;
  results: KnowledgeChunkResult[];
}> {
  try {
    const { KnowledgeService } = await import("../knowledge.js");
    const service = new KnowledgeService();
    const results = await service.search(userMessage, undefined, 3);

    if (!results.length) return { context: "", results: [] };

    const lines = [
      "【知识库参考资料 —— 以下每条数据均来自知识库，不可修改】",
    ];
    const scoredResults: KnowledgeChunkResult[] = [];
    results.forEach((r, i) => {
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
    logger.warn(e, "BusinessAgent knowledge search failed");
    return { context: "", results: [] };
  }
}

// ═══════════════════════════════════════════════════════
// 记忆注入
// ═══════════════════════════════════════════════════════

export async function injectMemories(
  userMessage: string,
  sessionId: string | null,
): Promise<[string, string[]]> {
  if (!sessionId) return ["", []];
  try {
    const engine = new MemoryEngine();
    const memories = await engine.search(
      userMessage,
      CUSTOMER_USER_ID,
      5,
      sessionId,
    );
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
