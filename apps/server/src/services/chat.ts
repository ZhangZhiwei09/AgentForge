// 聊天服务 —— 核心业务编排：记忆注入 → LLM 流式对话 → 记忆提取
// 这是 AgentForge 最重要的业务流程，串联了 PG、Milvus、LLM 三个系统
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel } from "../providers/registry.js";
import { MemoryEngine } from "./memory-engine.js";

// 拼在 system prompt 后面的记忆上下文前缀
const MEMORY_PROMPT_PREFIX = "\n\n# User Context (from memory)\nThe following is what you know about the user from past conversations:\n";

// 知识库上下文前缀
const KNOWLEDGE_PROMPT_PREFIX = "\n\n# Knowledge Base Reference\nUse the following reference documents to answer the user's question accurately:\n";

export class ChatService {
  // 阶段一：检索相关记忆并拼入 system prompt
  // 返回 [增强后的systemPrompt, 注入的记忆文本列表]
  private async injectMemories(
    userMessage: string,
    userId: string,
    systemPrompt: string,
  ): Promise<[string, string[]]> {
    try {
      const engine = new MemoryEngine();
      const memories = await engine.search(userMessage, userId, 5);
      // 过滤低相关性记忆（score ≤ 0.3 视为无关）
      const relevant = memories.filter((m) => m.score > 0.3);
      if (relevant.length > 0) {
        const memoryText = relevant.map((m) => `- ${m.content}`).join("\n");
        const enhancedPrompt = systemPrompt + MEMORY_PROMPT_PREFIX + memoryText;
        return [enhancedPrompt, relevant.map((m) => m.content)];
      }
    } catch (e) {
      console.warn(`[chat] Memory injection failed:`, e);
    }
    return [systemPrompt, []]; // 失败则用原始 system prompt 继续
  }

  // 阶段二：搜索知识库并拼入 system prompt
  // 返回 [增强后的systemPrompt, 知识库检索结果列表]
  private async injectKnowledge(
    userMessage: string,
    systemPrompt: string,
    kbIds: string[] | null,
  ): Promise<[string, Array<{ content: string; score: number; docTitle: string }>]> {
    if (!kbIds || kbIds.length === 0) {
      // 未指定知识库 → 搜索所有启用的知识库
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
      console.log(`[chat] Knowledge injected: ${results.length} references from ${kbIds.length} KB(s)`);
      return [enhancedPrompt, knowledgeResults];
    } catch (e) {
      console.warn(`[chat] Knowledge injection failed:`, e);
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

    // 5. 加载历史消息（按时间升序，构成完整对话上下文）
    const history = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    const chatMessages = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    // 6. 预生成助手消息 ID（用于前端在流开始前就知道消息 ID）
    const assistantMsgId = randomUUID();
    let fullContent = "";       // 累积完整响应文本
    let firstTokenTs: number | null = null; // 首个 token 到达时间（算 TTFT）
    const startTs = Date.now();
    let promptTokens = 0;
    let completionTokens = 0;

    // 8. 发送 meta 事件：告知前端模型、消息 ID、注入记忆数、知识库引用
    yield {
      type: "meta",
      message_id: assistantMsgId,
      model: resolvedModel,
      provider: providerName,
      memory_count: injectedMemories.length,
      knowledge_count: knowledgeResults.length,
      knowledge: knowledgeResults.length > 0 ? knowledgeResults : undefined,
    };

    // 8. 流式调用 LLM，逐 token 转发
    for await (const chunk of provider.streamChat(
      chatMessages,
      resolvedModel,
      enhancedPrompt, // 含记忆的增强 system prompt
    )) {
      if (chunk.type === "token") {
        if (firstTokenTs === null) firstTokenTs = Date.now();
        fullContent += chunk.content;
        yield {
          type: "token",
          content: chunk.content,
          message_id: assistantMsgId,
          model: resolvedModel,
        };
      } else if (chunk.type === "done") {
        // 9. 流结束：统计延迟和 token 用量
        promptTokens = chunk.usage?.prompt_tokens || 0;
        completionTokens = chunk.usage?.completion_tokens || 0;
        const latencyMs = Date.now() - startTs;
        const firstTokenMs = firstTokenTs ? firstTokenTs - startTs : latencyMs;

        // 10. 保存助手消息到 PG
        await prisma.message.create({
          data: {
            id: assistantMsgId,
            conversationId,
            role: "assistant",
            content: fullContent,
            model: resolvedModel,
          },
        });

        // 11. 自动生成对话标题（仅当标题还是默认值）
        if (conversation.title === "New Conversation") {
          const titleLine = userMessage.trim().split("\n")[0];
          const title = titleLine.length > 80 ? titleLine.slice(0, 80) : titleLine;
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { title },
          });
        }

        // 12. 阶段二：从对话中提取新的长期记忆
        let newMemoryCount = 0;
        try {
          const engine = new MemoryEngine();
          const extracted = await engine.extractAndStore(
            chatMessages,
            userId,
            conversationId,
            providerName,
          );
          newMemoryCount = extracted.length;
        } catch (e) {
          console.warn(`[chat] Memory extraction failed:`, e);
        }

        // 13. 发送 done 事件：携带用量统计和记忆处理结果
        yield {
          type: "done",
          message_id: assistantMsgId,
          model: resolvedModel,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            latency_ms: latencyMs,       // 总延迟
            first_token_ms: firstTokenMs, // 首 token 延迟（TTFT）
          },
          memory: {
            injected: injectedMemories.length,   // 本轮注入了多少条记忆
            extracted: newMemoryCount,           // 本轮提取了多少条新记忆
          },
        };
      }
    }
  }
}
