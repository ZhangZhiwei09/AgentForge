// DeepSeek Provider —— 封装 DeepSeek API（兼容 OpenAI 接口格式）
// 支持 token 流式输出 + function calling（tool calls）
import OpenAI from "openai";
import type { ToolDefinition } from "@agentforge/shared-types";
import type {
  LLMProvider,
  StreamChunk,
  ChatMessage,
  ChatSyncResult,
} from "./types.js";

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
      {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        provider: "deepseek",
        max_tokens: 65536,
      },
      {
        id: "deepseek-reasoner",
        name: "DeepSeek Reasoner",
        provider: "deepseek",
        max_tokens: 65536,
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        provider: "deepseek",
        max_tokens: 65536,
      },
    ];
  }

  // 非流式聊天：DeepSeek不支持原生JSON模式，通过prompt尾部追加指令实现
  async chatSync(
    messages: ChatMessage[],
    model: string,
    systemPrompt: string = "",
    temperature: number = 0.7,
    maxTokens: number = 4096,
    jsonMode: boolean = false,
  ): Promise<ChatSyncResult> {
    const fullMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [];
    // jsonMode: 在system prompt尾部追加JSON格式指令
    const effectivePrompt = jsonMode
      ? systemPrompt +
        "\n\nYou must respond with a valid JSON object. No markdown, no explanation, just the JSON."
      : systemPrompt;
    if (effectivePrompt) {
      fullMessages.push({ role: "system", content: effectivePrompt });
    }
    for (const m of messages) {
      fullMessages.push({ role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    }

    const response = await this.client.chat.completions.create({
      model,
      messages: fullMessages,
      temperature,
      max_tokens: maxTokens,
    });

    return {
      content: response.choices[0].message.content?.trim() || "",
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
      },
    };
  }

  // 核心流式聊天方法 —— 与 OpenAIProvider 逻辑一致，支持 tool calling
  async *streamChat(
    messages: ChatMessage[],
    model: string,
    systemPrompt: string = "",
    temperature: number = 0.7,
    maxTokens: number = 4096,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const fullMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [];
    if (systemPrompt) {
      fullMessages.push({ role: "system", content: systemPrompt });
    }

    for (const m of messages) {
      const om: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };
      if (m.tool_calls && m.tool_calls.length > 0) {
        om.tool_calls = m.tool_calls;
      }
      if (m.tool_call_id) {
        om.tool_call_id = m.tool_call_id;
      }
      fullMessages.push(
        om as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam,
      );
    }

    const params: Record<string, unknown> = {
      model,
      messages: fullMessages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    };

    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    // 传递 AbortSignal 给 OpenAI SDK — 支持前端中断
    if (signal) {
      params.signal = signal;
    }

    const stream = (await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams,
    )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    let promptTokens = 0;
    let completionTokens = 0;

    const toolCallAcc: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map();

    try {
      for await (const chunk of stream) {
        // Early exit: 检查中断信号
        if (signal?.aborted) break;

        const delta = chunk.choices[0]?.delta;

        // Handle tool call deltas
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallAcc.has(idx)) {
              toolCallAcc.set(idx, {
                id: tc.id || "",
                name: "",
                arguments: "",
              });
            }
            const acc = toolCallAcc.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }

        // Handle text content — flush tool calls first
        if (delta?.content) {
          for (const [idx, tc] of toolCallAcc) {
            if (tc.name && tc.arguments) {
              yield {
                type: "tool_call",
                tool_call: {
                  id: tc.id,
                  name: tc.name,
                  arguments: tc.arguments,
                },
              };
              toolCallAcc.delete(idx);
            }
          }
          yield { type: "token", content: delta.content };
        }

        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }

      // Flush remaining tool calls
      for (const [, tc] of toolCallAcc) {
        if (tc.name) {
          yield {
            type: "tool_call",
            tool_call: {
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments || "{}",
            },
          };
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
