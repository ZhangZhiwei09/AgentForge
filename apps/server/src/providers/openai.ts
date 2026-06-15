// OpenAI Provider —— 封装 OpenAI SDK，实现 LLMProvider 接口
// 支持 token 流式输出 + function calling（tool calls）
import OpenAI from "openai";
import type { ToolDefinition } from "@agentforge/shared-types";
import type {
  LLMProvider,
  StreamChunk,
  ChatMessage,
  ChatSyncResult,
} from "./types.js";

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
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        provider: "openai",
        max_tokens: 128000,
      },
      {
        id: "gpt-4-turbo",
        name: "GPT-4 Turbo",
        provider: "openai",
        max_tokens: 128000,
      },
    ];
  }

  // 非流式聊天：用于记忆提取、Rerank、结构化JSON输出等场景
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
    if (systemPrompt) {
      fullMessages.push({ role: "system", content: systemPrompt });
    }
    for (const m of messages) {
      fullMessages.push({ role: m.role as any, content: m.content });
    }

    const params: Record<string, unknown> = {
      model,
      messages: fullMessages,
      temperature,
      max_tokens: maxTokens,
    };

    // OpenAI原生JSON模式
    if (jsonMode) {
      params.response_format = { type: "json_object" };
    }

    const response = await this.client.chat.completions.create(params as any);

    return {
      content: response.choices[0].message.content?.trim() || "",
      usage: {
        prompt_tokens: response.usage?.prompt_tokens || 0,
        completion_tokens: response.usage?.completion_tokens || 0,
      },
    };
  }

  // 核心方法：异步生成器，逐个 yield token/tool_call/done 片段给上层
  async *streamChat(
    messages: ChatMessage[],
    model: string,
    systemPrompt: string = "",
    temperature: number = 0.7,
    maxTokens: number = 4096,
    tools?: ToolDefinition[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    // 构建完整消息列表：system prompt（如有）放在最前面
    const fullMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      [];
    if (systemPrompt) {
      fullMessages.push({ role: "system", content: systemPrompt });
    }

    // 转换 ChatMessage → OpenAI message format
    for (const m of messages) {
      const om: Record<string, unknown> = {
        role: m.role,
        content: m.content,
      };
      // 如果有 tool_calls，附加到 assistant 消息上
      if (m.tool_calls && m.tool_calls.length > 0) {
        om.tool_calls = m.tool_calls;
      }
      // 如果有 tool_call_id，附加到 tool 消息上
      if (m.tool_call_id) {
        om.tool_call_id = m.tool_call_id;
      }
      fullMessages.push(
        om as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam,
      );
    }

    // 构建请求参数
    const params: Record<string, unknown> = {
      model,
      messages: fullMessages,
      temperature,
      max_tokens: maxTokens,
      stream: true, // 关键：启用 SSE 流式输出
    };

    // 如果有工具定义，附加到请求中
    if (tools && tools.length > 0) {
      params.tools = tools;
    }

    // 传递 AbortSignal 给 OpenAI SDK — 支持前端中断
    if (signal) {
      params.signal = signal;
    }

    // 发起流式请求 (cast needed because params is built dynamically)
    const stream = (await this.client.chat.completions.create(
      params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams,
    )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

    let promptTokens = 0;
    let completionTokens = 0;

    // accumulator for tool calls that arrive in fragments
    const toolCallAcc: Map<
      number,
      { id: string; name: string; arguments: string }
    > = new Map();

    // 遍历 SSE 事件流
    try {
      for await (const chunk of stream) {
        // Early exit: 检查中断信号
        if (signal?.aborted) break;

        const delta = chunk.choices[0]?.delta;

        // Handle tool call deltas (accumulate across chunks)
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

        // Handle text content tokens — flush tool calls first
        if (delta?.content) {
          // Flush any pending completed tool calls before yielding text
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

        // 部分 chunk 附带 usage 信息（通常在最后一个 chunk）
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }

      // Flush any remaining tool calls at stream end
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
