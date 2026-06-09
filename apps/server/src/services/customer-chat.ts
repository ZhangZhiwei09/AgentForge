// 客服聊天服务 —— 匿名会话 + 知识库检索 + 中文客服 Prompt
// 与 ChatService 独立实现（不共享基类），因为业务逻辑差异较大：
//   - 不需要记忆注入/提取（匿名用户无长期记忆）
//   - 需要自动搜索知识库获取参考答案
//   - 基于 sessionId 管理匿名对话生命周期
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel } from "../providers/registry.js";

const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002"; // 客服系统专用用户
const MAX_HISTORY_MESSAGES = 20; // 只取最近 20 条历史，控制 token 消耗

// 客服系统提示词模板：{knowledge_context} 会被替换为知识库检索结果
const CUSTOMER_SERVICE_PROMPT = `你是一个专业的客户服务代表，负责回答客户的问题和提供帮助。

## 回答规则
1. 如果下方提供了【知识库参考资料】，请优先基于参考资料回答问题，确保信息准确。
2. 如果参考资料中找不到答案，请诚实告知客户你暂时无法回答，并建议其联系人工客服。
3. 保持礼貌、专业和耐心的态度。
4. 回答要简洁明了，直接回应客户问题，不要添加无关信息。

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
      console.log(results, 'results');

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
      console.warn(`[customer-chat] Knowledge search failed:`, e);
      return { context: "", results: [] };
    }
  }

  // 客服聊天主流程
  async *streamChat(
    sessionId: string | null,
    userMessage: string,
  ): AsyncGenerator<Record<string, unknown>> {
    // 1. 获取或创建会话
    const conversation = await this.getOrCreateConversation(sessionId);

    const [providerName, resolvedModel] = resolveModel(this.modelId);
    const provider = getProvider(providerName);

    // 2. 加载最近历史消息（倒序取 → 再反转回正序）
    const history = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: MAX_HISTORY_MESSAGES,
    });
    const reversed = history.reverse();

    // 3. 保存用户消息
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "user",
        content: userMessage,
        model: resolvedModel,
      },
    });

    // 4. 搜索知识库，同时获取格式化文本和结构化结果
    const { context: knowledgeContext, results: knowledgeResults } =
      await this.fetchKnowledge(userMessage);

    // 5. 构建消息列表：历史 + 当前用户消息
    const chatMessages = reversed.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    chatMessages.push({ role: "user", content: userMessage });

    const assistantMsgId = randomUUID();
    let fullContent = "";

    // 6. 发送 meta 事件（含知识库检索结果，前端可用于展示参考来源）
    yield {
      type: "meta",
      message_id: assistantMsgId,
      session_id: conversation.sessionId,
      model: resolvedModel,
      provider: providerName,
      knowledge: knowledgeResults, // ← 新增：知识库检索结果 + 分数
    };

    // 7. 将知识库检索结果填入 system prompt
    const systemPrompt = CUSTOMER_SERVICE_PROMPT.replace(
      "{knowledge_context}",
      knowledgeContext,
    );

    // 8. 流式调用 LLM
    for await (const chunk of provider.streamChat(
      chatMessages,
      resolvedModel,
      systemPrompt,
    )) {
      if (chunk.type === "token") {
        fullContent += chunk.content;
        yield {
          type: "token",
          content: chunk.content,
          message_id: assistantMsgId,
        };
      } else if (chunk.type === "done") {
        const promptTokens = chunk.usage?.prompt_tokens || 0;
        const completionTokens = chunk.usage?.completion_tokens || 0;
        yield {
          type: "done",
          message_id: assistantMsgId,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
      }
    }

    // 9. 保存助手消息（放在流结束后，在 yield done 之后）
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
