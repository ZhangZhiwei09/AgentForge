// 客服聊天服务 —— 匿名会话 + 知识库检索 + 工具调用 + 中文客服 Prompt
// 与 ChatService 独立实现（不共享基类），因为业务逻辑差异较大：
//   - 不需要记忆注入/提取（匿名用户无长期记忆）
//   - 需要自动搜索知识库获取参考答案
//   - 基于 sessionId 管理匿名对话生命周期
//   - 始终启用 get_current_time 工具，用于确认订单时间等场景
//   - V2 增强：意图识别、工作时间感知、追问建议生成
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { logger } from "@agentforge/logger";
import { toolRegistry } from "../tools/registry.js";
import { intentDetector } from "./intent-detector.js";

const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002"; // 客服系统专用用户
const MAX_HISTORY_MESSAGES = 20; // 只取最近 20 条历史，控制 token 消耗
const MAX_TOOL_ROUNDS = 3; // 客服场景工具调用最大轮数（比主聊天少）

// 工作时间配置（可通过环境变量覆盖）
const SERVICE_HOURS_START = parseInt(process.env.CS_SERVICE_HOURS_START || "9", 10);  // 默认 9:00
const SERVICE_HOURS_END = parseInt(process.env.CS_SERVICE_HOURS_END || "18", 10);    // 默认 18:00
const SERVICE_DAYS = (process.env.CS_SERVICE_DAYS || "1,2,3,4,5").split(",").map(Number); // 默认周一~周五

// 客服系统提示词模板：{knowledge_context} 会被替换为知识库检索结果
const CUSTOMER_SERVICE_PROMPT = `你是一个专业的客户服务代表，负责回答客户的问题和提供帮助。

## 可用工具
你可以使用 get_current_time 工具获取当前时间，用于：
- 确认客户订单的时间点
- 询问客户购买时间段
- 判断是否在服务时间范围内
- 计算退换货期限

## 回答规则
1. 如果下方提供了【知识库参考资料】，请优先基于参考资料回答问题，确保信息准确。
2. 如果参考资料中找不到答案，请诚实告知客户你暂时无法回答，并建议其联系人工客服。
3. 保持礼貌、专业和耐心的态度。
4. 回答要简洁明了，直接回应客户问题，不要添加无关信息。
5. 在回答的最后，根据对话内容生成 2-3 个客户可能关心的后续问题建议，以 JSON 数组格式放在回答末尾，格式为：{"suggestions": ["问题1", "问题2", "问题3"]}。请确保 JSON 是有效的且只占一行。

{knowledge_context}`;

// 知识库检索结果（暴露给前端）
export interface KnowledgeChunkResult {
  content: string;   // chunk 文本（截断 300 字符）
  score: number;    // Milvus 相似度分数（0.0~1.0）
  docTitle: string; // 所属文档标题
}

export class CustomerChatService {
  private modelId: string | null;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
  }

  // 获取或创建客服会话：有 sessionId 则复用，没有则新建
  private async getOrCreateConversation(sessionId: string | null) {
    if (sessionId) {
      const existing = await prisma.conversation.findFirst({
        where: {
          sessionId,
          type: "customer_service", // 只查客服类型会话
        },
      });
      if (existing) return existing;
    }

    // 新建匿名会话
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

  // 搜索知识库，返回结构化结果（含分数）和格式化 prompt 片段
  private async fetchKnowledge(userMessage: string): Promise<{
    context: string;
    results: KnowledgeChunkResult[];
  }> {
    try {
      // 动态导入避免循环依赖
      const { KnowledgeService } = await import("./knowledge.js");
      const service = new KnowledgeService();

      const results = await service.search(userMessage, undefined, 3); // 搜索 top 3
      logger.debug({ results: results.length }, "Knowledge search results");

      if (!results.length) return { context: "", results: [] };

      const lines = ["【知识库参考资料】"];
      const scoredResults: KnowledgeChunkResult[] = [];
      results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.content}`);
        scoredResults.push({
          content: r.content.slice(0, 300), // 前端展示用，截断 300 字符
          score: r.score,
          docTitle: r.docTitle || r.docId, // 优先使用文档标题，回退到 docId
        });
      });
      return {
        context: "\n\n".concat(lines.join("\n")),
        results: scoredResults,
      };
    } catch (e) {
      logger.warn(e, "Customer chat knowledge search failed");
      return { context: "", results: [] };
    }
  }

  // 检查当前是否在工作时间
  private isWithinServiceHours(): boolean {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=周日, 1=周一, ..., 6=周六
    const hour = now.getHours();

    // 周日=0，需要转换为 1=周一, 7=周日
    const adjustedDay = dayOfWeek === 0 ? 7 : dayOfWeek;

    if (!SERVICE_DAYS.includes(adjustedDay)) return false;
    if (hour < SERVICE_HOURS_START || hour >= SERVICE_HOURS_END) return false;
    return true;
  }

  // 客服聊天主流程（含工具调用循环）
  async *streamChat(
    sessionId: string | null,
    userMessage: string,
  ): AsyncGenerator<Record<string, unknown>> {
    // 1. 获取或创建会话
    const conversation = await this.getOrCreateConversation(sessionId);

    const [providerName, resolvedModel] = resolveModel(this.modelId);
    const provider = getProvider(providerName);

    // 2. 意图识别
    const { intent } = intentDetector.detect(userMessage);
    logger.debug({ intent, message: userMessage.slice(0, 50) }, "Intent detected");

    // 3. 工作时间检查（非工作时间给出提示但不阻止）
    const withinHours = this.isWithinServiceHours();

    // 4. 加载最近历史消息（倒序取 → 再反转回正序）
    const history = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: MAX_HISTORY_MESSAGES,
    });
    const reversed = history.reverse();

    // 5. 保存用户消息
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "user",
        content: userMessage,
        model: resolvedModel,
      },
    });

    // 更新会话的意图标签（字段可能尚未迁移，静默失败）
    if (intent !== "其他咨询") {
      try {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { intent },
        });
      } catch {
        // intent 列可能还未迁移，跳过
      }
    }

    // 6. 搜索知识库
    const { context: knowledgeContext, results: knowledgeResults } =
      await this.fetchKnowledge(userMessage);

    // 7. 构建消息列表：历史 + 当前用户消息
    const conversationMessages: ChatMessage[] = reversed.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    conversationMessages.push({ role: "user", content: userMessage });

    // 8. 客服始终启用 get_current_time 工具
    const toolDefs = toolRegistry.getDefinitions(["get_current_time"]);

    // 9. 构建 system prompt（含知识库上下文 + 工作时间提示）
    const hoursNote = withinHours
      ? ""
      : "\n\n注意：当前为非工作时间（工作日 9:00-18:00），请在回复开头礼貌提醒客户当前为非工作时间，消息将在工作时间处理。但还是要尽力回答客户的问题。";
    const systemPrompt = CUSTOMER_SERVICE_PROMPT.replace(
      "{knowledge_context}",
      knowledgeContext + hoursNote,
    );

    const assistantMsgId = randomUUID();
    let fullContent = "";
    let totalToolCalls = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // 10. 发送 meta 事件（含意图信息）
    yield {
      type: "meta",
      message_id: assistantMsgId,
      session_id: conversation.sessionId,
      model: resolvedModel,
      provider: providerName,
      knowledge: knowledgeResults,
      tools_enabled: ["get_current_time"],
      intent,
      within_service_hours: withinHours,
    };

    // 11. 工具调用循环（同 ChatService 模式）
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let roundContent = "";
      const executedTools: Array<{
        tc: { id: string; name: string; arguments: string };
        result: string;
      }> = [];

      for await (const chunk of provider.streamChat(
        conversationMessages,
        resolvedModel,
        systemPrompt,
        undefined,
        undefined,
        toolDefs,
      )) {
        if (chunk.type === "token") {
          roundContent += chunk.content!;
          fullContent += chunk.content!;
          yield {
            type: "token",
            content: chunk.content,
            message_id: assistantMsgId,
          };
        } else if (chunk.type === "tool_call" && chunk.tool_call) {
          const tc = chunk.tool_call;
          logger.debug({ tool: tc.name, args: tc.arguments.slice(0, 100) }, "Customer chat tool call");

          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.arguments); } catch { /* keep empty */ }

          const result = await toolRegistry.execute(tc.name, args);
          executedTools.push({ tc, result });

          yield {
            type: "tool_call",
            tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
            message_id: assistantMsgId,
          };
          yield {
            type: "tool_result",
            tool_result: { tool_call_id: tc.id, name: tc.name, result },
            message_id: assistantMsgId,
          };
        } else if (chunk.type === "done") {
          totalPromptTokens += chunk.usage?.prompt_tokens || 0;
          totalCompletionTokens += chunk.usage?.completion_tokens || 0;
        }
      }

      if (executedTools.length === 0) break;

      totalToolCalls += executedTools.length;

      // 追加工具消息到上下文
      conversationMessages.push({
        role: "assistant",
        content: roundContent || null,
        tool_calls: executedTools.map(({ tc }) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      for (const { tc, result } of executedTools) {
        conversationMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }
    }

    // 12. 从回答中提取追问建议
    let suggestions: string[] = [];
    try {
      const jsonMatch = fullContent.match(/\{"suggestions"\s*:\s*\[(.*?)\]\}/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.suggestions)) {
          suggestions = parsed.suggestions.slice(0, 3);
        }
        // 从 fullContent 中移除 JSON 块，避免展示给用户
        fullContent = fullContent.replace(jsonMatch[0], "").trim();
      }
    } catch {
      // 解析失败则忽略，suggestions 保持空数组
    }

    // 13. 发送 done 事件
    yield {
      type: "done",
      message_id: assistantMsgId,
      usage: {
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        total_tokens: totalPromptTokens + totalCompletionTokens,
      },
      tool_calls_count: totalToolCalls > 0 ? totalToolCalls : undefined,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    };

    // 14. 保存助手消息
    await prisma.message.create({
      data: {
        id: assistantMsgId,
        conversationId: conversation.id,
        role: "assistant",
        content: fullContent,
        model: resolvedModel,
      },
    });
  }
}
