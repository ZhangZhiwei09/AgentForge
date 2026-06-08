// DeepSeek Provider —— 封装 DeepSeek API（兼容 OpenAI 接口格式）
// 实现 LLMProvider 接口，与 OpenAIProvider 结构对称，方便对比维护
import OpenAI from "openai";
import type { LLMProvider, StreamChunk } from "./types.js";

export class DeepSeekProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseUrl: string = "https://api.deepseek.com/v1") {
    // DeepSeek API 兼容 OpenAI SDK，只需换 baseURL 即可
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });
  }

  listModels() {
    return [
      { id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", max_tokens: 65536 },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", provider: "deepseek", max_tokens: 65536 },
    ];
  }

  // 核心流式聊天方法 —— 与 OpenAIProvider 逻辑一致
  async *streamChat(
    messages: Array<{ role: string; content: string }>,
    model: string,
    systemPrompt: string = "",
    temperature: number = 0.7,
    maxTokens: number = 4096,
  ): AsyncGenerator<StreamChunk> {
    const fullMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (systemPrompt) {
      fullMessages.push({ role: "system", content: systemPrompt });
    }
    fullMessages.push(
      ...messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }))
    );

    const stream = await this.client.chat.completions.create({
      model,
      messages: fullMessages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    });

    let promptTokens = 0;
    let completionTokens = 0;

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          yield { type: "token", content: delta.content };
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }
    } finally {
      yield {
        type: "done",
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    }
  }
}
