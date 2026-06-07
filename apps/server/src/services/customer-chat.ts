import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel } from "../providers/registry.js";

const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";
const MAX_HISTORY_MESSAGES = 20;

const CUSTOMER_SERVICE_PROMPT = `你是一个专业的客户服务代表，负责回答客户的问题和提供帮助。

## 回答规则
1. 如果下方提供了【知识库参考资料】，请优先基于参考资料回答问题，确保信息准确。
2. 如果参考资料中找不到答案，请诚实告知客户你暂时无法回答，并建议其联系人工客服。
3. 保持礼貌、专业和耐心的态度。
4. 回答要简洁明了，直接回应客户问题，不要添加无关信息。

{knowledge_context}`;

export class CustomerChatService {
  private modelId: string | null;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
  }

  private async getOrCreateConversation(sessionId: string | null) {
    if (sessionId) {
      const existing = await prisma.conversation.findFirst({
        where: {
          sessionId,
          type: "customer_service",
        },
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

  private async fetchKnowledge(userMessage: string): Promise<string> {
    try {
      const { KnowledgeService } = await import("./knowledge.js");
      const service = new KnowledgeService();
      const results = await service.search(userMessage, undefined, 3);

      if (!results.length) return "";

      const lines = ["【知识库参考资料】"];
      results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.content}`);
      });
      return "\n\n".concat(lines.join("\n"));
    } catch (e) {
      console.warn(`[customer-chat] Knowledge search failed:`, e);
      return "";
    }
  }

  async *streamChat(
    sessionId: string | null,
    userMessage: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const conversation = await this.getOrCreateConversation(sessionId);

    const [providerName, resolvedModel] = resolveModel(this.modelId);
    const provider = getProvider(providerName);

    // Load history
    const history = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: MAX_HISTORY_MESSAGES,
    });
    const reversed = history.reverse();

    // Save user message
    await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId: conversation.id,
        role: "user",
        content: userMessage,
        model: resolvedModel,
      },
    });

    // Search knowledge base
    const knowledgeContext = await this.fetchKnowledge(userMessage);

    // Build messages
    const chatMessages = reversed.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    chatMessages.push({ role: "user", content: userMessage });

    const assistantMsgId = randomUUID();
    let fullContent = "";

    yield {
      type: "meta",
      message_id: assistantMsgId,
      session_id: conversation.sessionId,
      model: resolvedModel,
      provider: providerName,
    };

    const systemPrompt = CUSTOMER_SERVICE_PROMPT.replace(
      "{knowledge_context}",
      knowledgeContext,
    );

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

    // Save assistant message
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
