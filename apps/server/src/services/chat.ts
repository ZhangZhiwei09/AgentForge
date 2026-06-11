// 聊天服务 —— 核心业务编排：记忆注入 → LLM 流式对话 → 工具调用 → 记忆提取
// 这是 AgentForge 最重要的业务流程，串联了 PG、Milvus、LLM、Tool 四个系统
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel } from "../providers/registry.js";
import type { ChatMessage } from "../providers/types.js";
import { MemoryEngine } from "./memory-engine.js";
import { toolRegistry } from "../tools/registry.js";
import { logger } from "@agentforge/logger";
import { truncateHistory } from "../lib/context-window.js";

// 拼在 system prompt 后面的记忆上下文前缀
const MEMORY_PROMPT_PREFIX = "\n\n# User Context (from memory)\nThe following is what you know about the user from past conversations:\n";

// 知识库上下文前缀
const KNOWLEDGE_PROMPT_PREFIX = "\n\n# Knowledge Base Reference\nUse the following reference documents to answer the user's question accurately:\n";

// 最大工具调用轮数（防止无限循环）
const MAX_TOOL_ROUNDS = 5;

export class ChatService {
  // 阶段一：检索相关记忆并拼入 system prompt
  private async injectMemories(
    userMessage: string,
    userId: string,
    systemPrompt: string,
  ): Promise<[string, string[]]> {
    try {
      const engine = new MemoryEngine();
      const memories = await engine.search(userMessage, userId, 5);
      const relevant = memories.filter((m) => m.score > 0.3);
      if (relevant.length > 0) {
        const memoryText = relevant.map((m) => `- ${m.content}`).join("\n");
        const enhancedPrompt = systemPrompt + MEMORY_PROMPT_PREFIX + memoryText;
        return [enhancedPrompt, relevant.map((m) => m.content)];
      }
    } catch (e) {
      logger.warn(e, "Memory injection failed");
    }
    return [systemPrompt, []];
  }

  // 阶段二：搜索知识库并拼入 system prompt
  private async injectKnowledge(
    userMessage: string,
    systemPrompt: string,
    kbIds: string[] | null,
  ): Promise<[string, Array<{ content: string; score: number; docTitle: string }>]> {
    if (!kbIds || kbIds.length === 0) {
      try {
        const { prisma } = await import("../db.js");
        const allKbs = await prisma.knowledgeBase.findMany({
          where: { enabled: true },
          select: { id: true },
        });
        if (allKbs.length === 0) return [systemPrompt, []];
        kbIds = allKbs.map((kb) => kb.id);
      } catch {
        return [systemPrompt, []];
      }
    }

    try {
      const { KnowledgeService } = await import("./knowledge.js");
      const service = new KnowledgeService();
      const results = await service.search(userMessage, kbIds, 3);

      if (!results.length) return [systemPrompt, []];

      const lines: string[] = [];
      const knowledgeResults: Array<{ content: string; score: number; docTitle: string }> = [];
      results.forEach((r, i) => {
        lines.push(`[Ref ${i + 1}] ${r.content}`);
        knowledgeResults.push({
          content: r.content.slice(0, 300),
          score: r.score,
          docTitle: r.docTitle || r.docId,
        });
      });

      const knowledgeText = lines.join("\n\n");
      const enhancedPrompt = systemPrompt + KNOWLEDGE_PROMPT_PREFIX + knowledgeText;
      logger.info({ refs: results.length, kbs: kbIds.length }, "Knowledge injected");
      return [enhancedPrompt, knowledgeResults];
    } catch (e) {
      logger.warn(e, "Knowledge injection failed");
    }
    return [systemPrompt, []];
  }

  // 主流程：异步生成器，逐 chunk yield 给 SSE 路由
  async *streamChat(
    conversationId: string,
    userMessage: string,
    modelId?: string | null,
    systemPrompt: string = "",
    kbIds: string[] | null = null,
    enabledTools?: string[] | null,
  ): AsyncGenerator<Record<string, unknown>> {
    // 1. 解析模型 → 找到对应的 Provider
    const [providerName, resolvedModel] = resolveModel(modelId);
    const provider = getProvider(providerName);

    // 2. 获取对话和用户信息
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new Error(`Conversation '${conversationId}' not found`);
    }

    const userId = conversation.userId;

    // 3. 注入长期记忆到 system prompt
    const [systemWithMemories, injectedMemories] = await this.injectMemories(
      userMessage,
      userId,
      systemPrompt,
    );

    // 4. 注入知识库上下文到 system prompt（在记忆之后）
    const [enhancedPrompt, knowledgeResults] = await this.injectKnowledge(
      userMessage,
      systemWithMemories,
      kbIds,
    );

    // 5. 保存用户消息到 PG
    const userMsg = await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: "user",
        content: userMessage,
        model: resolvedModel,
      },
    });

    // 6. 加载历史消息（按时间升序，构成完整对话上下文）
    const history = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    // 7. 构建初始对话消息列表（用于 LLM 上下文），并截断以适应token预算
    const rawMessages: ChatMessage[] = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    // 8000 token预算：为system prompt + context + response留出空间
    const conversationMessages = truncateHistory(rawMessages, 8000);

    // 8. 获取启用的工具定义（仅当显式指定 tools 参数时才发送工具）
    const toolDefs = enabledTools && enabledTools.length > 0
      ? toolRegistry.getDefinitions(enabledTools)
      : [];
    const toolsEnabled = toolDefs.length > 0;

    // 9. 预生成助手消息 ID（用于前端在流开始前就知道消息 ID）
    const assistantMsgId = randomUUID();
    let fullContent = ""; // 累积所有轮次的响应文本
    let firstTokenTs: number | null = null;
    const startTs = Date.now();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalToolCalls = 0;

    // 10. 发送 meta 事件
    yield {
      type: "meta",
      message_id: assistantMsgId,
      model: resolvedModel,
      provider: providerName,
      memory_count: injectedMemories.length,
      knowledge_count: knowledgeResults.length,
      knowledge: knowledgeResults.length > 0 ? knowledgeResults : undefined,
      tools_enabled: toolsEnabled ? toolRegistry.listNames() : undefined,
    };

    // 11. 工具调用循环：最多 MAX_TOOL_ROUNDS 轮
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let roundContent = "";
      // Collect tool calls first, execute after stream completes
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
      }> = [];
      const executedTools: Array<{
        tc: { id: string; name: string; arguments: string };
        result: string;
      }> = [];

      // 调用 LLM（流式） — 收集token和tool_call，延迟执行
      for await (const chunk of provider.streamChat(
        conversationMessages,
        resolvedModel,
        enhancedPrompt,
        undefined,
        undefined,
        toolDefs.length > 0 ? toolDefs : undefined,
      )) {
        if (chunk.type === "token") {
          if (firstTokenTs === null) firstTokenTs = Date.now();
          roundContent += chunk.content!;
          fullContent += chunk.content!;
          yield {
            type: "token",
            content: chunk.content,
            message_id: assistantMsgId,
            model: resolvedModel,
          };
        } else if (chunk.type === "tool_call" && chunk.tool_call) {
          const tc = chunk.tool_call;
          logger.debug({ tool: tc.name, args: tc.arguments.slice(0, 100) }, "Tool call");

          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.arguments);
          } catch {
            logger.warn({ arguments: tc.arguments }, "Failed to parse tool arguments");
          }
          pendingToolCalls.push({ id: tc.id, name: tc.name, args });
        } else if (chunk.type === "done") {
          // 累积 token 用量
          totalPromptTokens += chunk.usage?.prompt_tokens || 0;
          totalCompletionTokens += chunk.usage?.completion_tokens || 0;
        }
      }

      // Execute pending tool calls — parallel for parallelizable tools
      if (pendingToolCalls.length > 0) {
        const allTools = toolRegistry.getAll();
        const toolMetaMap = new Map(allTools.map((t) => [t.definition.function.name, t]));

        // Split into parallelizable and sequential
        const parallel: typeof pendingToolCalls = [];
        const sequential: typeof pendingToolCalls = [];
        for (const ptc of pendingToolCalls) {
          const meta = toolMetaMap.get(ptc.name);
          if (meta?.parallelizable) {
            parallel.push(ptc);
          } else {
            sequential.push(ptc);
          }
        }

        // Execute parallelizable tools concurrently
        if (parallel.length > 0) {
          const parallelResults = await Promise.all(
            parallel.map(async (ptc) => ({
              tc: { id: ptc.id, name: ptc.name, arguments: JSON.stringify(ptc.args) },
              result: await toolRegistry.execute(ptc.name, ptc.args),
            })),
          );
          executedTools.push(...parallelResults);
        }

        // Execute sequential tools one by one
        for (const ptc of sequential) {
          const result = await toolRegistry.execute(ptc.name, ptc.args);
          executedTools.push({
            tc: { id: ptc.id, name: ptc.name, arguments: JSON.stringify(ptc.args) },
            result,
          });
        }

        // Yield tool_call and tool_result events to frontend
        for (const { tc, result } of executedTools) {
          yield {
            type: "tool_call",
            tool_call: { id: tc.id, name: tc.name, arguments: tc.arguments },
            message_id: assistantMsgId,
          };
          yield {
            type: "tool_result",
            tool_result: {
              tool_call_id: tc.id,
              name: tc.name,
              result,
            },
            message_id: assistantMsgId,
          };
        }
      }

      // 本轮无工具调用 → 循环结束
      if (executedTools.length === 0) break;

      totalToolCalls += executedTools.length;

      // 将工具调用消息追加到对话上下文中（供下一轮 LLM 使用）
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

      logger.debug({ round: round + 1, toolCount: executedTools.length }, "Tool round complete");
    }

    // 12. 保存助手消息到 PG（累积的完整响应文本）
    await prisma.message.create({
      data: {
        id: assistantMsgId,
        conversationId,
        role: "assistant",
        content: fullContent,
        model: resolvedModel,
      },
    });

    // 13. 自动生成对话标题（仅当标题还是默认值）
    if (conversation.title === "New Conversation") {
      const titleLine = userMessage.trim().split("\n")[0];
      const title = titleLine.length > 80 ? titleLine.slice(0, 80) : titleLine;
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { title },
      });
    }

    // 14. 阶段三：异步投递记忆提取任务（P1-1 BullMQ 后台队列）
    let newMemoryCount = 0;
    try {
      const { getMemoryQueue } = await import("../jobs/queues.js");
      const queue = getMemoryQueue();
      const msgs = conversationMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content || "" }));
      if (queue) {
        // 投递到 BullMQ 后台队列，立即返回
        await queue.add("extract", {
          messages: msgs,
          userId,
          conversationId,
          providerName,
        });
        logger.debug({ conversationId }, "Memory extraction job dispatched");
      } else {
        // 优雅降级：Redis 不可用，回退同步提取
        const engine = new MemoryEngine();
        const extracted = await engine.extractAndStore(
          msgs, userId, conversationId, providerName,
        );
        newMemoryCount = extracted.length;
      }
    } catch (e) {
      logger.warn(e, "Memory extraction dispatch failed");
    }

    // 15. 延迟统计
    const latencyMs = Date.now() - startTs;
    const firstTokenMs = firstTokenTs ? firstTokenTs - startTs : latencyMs;

    // 16. 发送 done 事件：携带用量统计、工具调用统计和记忆处理结果
    yield {
      type: "done",
      message_id: assistantMsgId,
      model: resolvedModel,
      usage: {
        prompt_tokens: totalPromptTokens,
        completion_tokens: totalCompletionTokens,
        total_tokens: totalPromptTokens + totalCompletionTokens,
        latency_ms: latencyMs,
        first_token_ms: firstTokenMs,
      },
      memory: {
        injected: injectedMemories.length,
        extracted: newMemoryCount,
      },
      tool_calls_count: totalToolCalls > 0 ? totalToolCalls : undefined,
    };
  }
}
