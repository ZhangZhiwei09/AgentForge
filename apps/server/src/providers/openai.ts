// OpenAI Provider —— 封装 OpenAI SDK，实现 LLMProvider 接口
// OpenAI 和 DeepSeek 共用 OpenAI 兼容 API 格式，因此都用 OpenAI SDK 实例
import OpenAI from "openai";
import type { LLMProvider, StreamChunk } from "./types.js";

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseUrl: string = "https://api.openai.com/v1") {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl, // 支持自定义 base URL（代理、私有部署等）
    });
  }

  // 返回 OpenAI 目前支持的模型列表
  listModels() {
    return [
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", max_tokens: 128000 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", max_tokens: 128000 },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", provider: "openai", max_tokens: 128000 },
    ];
  }

  // 核心方法：异步生成器，逐个 yield token 片段给上层
  async *streamChat(
    messages: Array<{ role: string; content: string }>,
    model: string,
    systemPrompt: string = "",
    temperature: number = 0.7,
    maxTokens: number = 4096,
  ): AsyncGenerator<StreamChunk> {
    // 构建完整消息列表：system prompt（如有）放在最前面
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

    // 发起流式请求
    const stream = await this.client.chat.completions.create({
      model,
      messages: fullMessages,
      temperature,
      max_tokens: maxTokens,
      stream: true, // 关键：启用 SSE 流式输出
    });

    let promptTokens = 0;
    let completionTokens = 0;

    // 遍历 SSE 事件流
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        // 每个 chunk 的 delta.content 是增量文本片段
        if (delta?.content) {
          yield { type: "token", content: delta.content };
        }
        // 部分 chunk 附带 usage 信息（通常在最后一个 chunk）
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }
    } finally {
      // 无论流正常结束还是中断，都 yield 一个 done 片段传递 token 用量
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
