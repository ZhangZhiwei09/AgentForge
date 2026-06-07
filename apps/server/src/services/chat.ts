import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { getProvider, resolveModel } from "../providers/registry.js";
import { MemoryEngine } from "./memory-engine.js";

const MEMORY_PROMPT_PREFIX = "\n\n# User Context (from memory)\nThe following is what you know about the user from past conversations:\n";

export class ChatService {
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
      console.warn(`[chat] Memory injection failed:`, e);
    }
    return [systemPrompt, []];
  }

  async *streamChat(
    conversationId: string,
    userMessage: string,
    modelId?: string | null,
    systemPrompt: string = "",
  ): AsyncGenerator<Record<string, unknown>> {
    const [providerName, resolvedModel] = resolveModel(modelId);
    const provider = getProvider(providerName);

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new Error(`Conversation '${conversationId}' not found`);
    }

    const userId = conversation.userId;

    // Phase 1: Retrieve relevant memories
    const [enhancedPrompt, injectedMemories] = await this.injectMemories(
      userMessage,
      userId,
      systemPrompt,
    );

    // Save user message
    const userMsg = await prisma.message.create({
      data: {
        id: randomUUID(),
        conversationId,
        role: "user",
        content: userMessage,
        model: resolvedModel,
      },
    });

    // Load history
    const history = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });

    const chatMessages = history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const assistantMsgId = randomUUID();
    let fullContent = "";
    let firstTokenTs: number | null = null;
    const startTs = Date.now();
    let promptTokens = 0;
    let completionTokens = 0;

    yield {
      type: "meta",
      message_id: assistantMsgId,
      model: resolvedModel,
      provider: providerName,
      memory_count: injectedMemories.length,
    };

    for await (const chunk of provider.streamChat(
      chatMessages,
      resolvedModel,
      enhancedPrompt,
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
        promptTokens = chunk.usage?.prompt_tokens || 0;
        completionTokens = chunk.usage?.completion_tokens || 0;
        const latencyMs = Date.now() - startTs;
        const firstTokenMs = firstTokenTs ? firstTokenTs - startTs : latencyMs;

        // Save assistant message
        await prisma.message.create({
          data: {
            id: assistantMsgId,
            conversationId,
            role: "assistant",
            content: fullContent,
            model: resolvedModel,
          },
        });

        // Auto-generate conversation title
        if (conversation.title === "New Conversation") {
          const titleLine = userMessage.trim().split("\n")[0];
          const title = titleLine.length > 80 ? titleLine.slice(0, 80) : titleLine;
          await prisma.conversation.update({
            where: { id: conversationId },
            data: { title },
          });
        }

        // Phase 2: Extract memories
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

        yield {
          type: "done",
          message_id: assistantMsgId,
          model: resolvedModel,
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
            latency_ms: latencyMs,
            first_token_ms: firstTokenMs,
          },
          memory: {
            injected: injectedMemories.length,
            extracted: newMemoryCount,
          },
        };
      }
    }
  }
}
