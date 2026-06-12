// LLM Provider 抽象接口 —— 定义所有 LLM 厂商必须实现的契约
// 业务层（services）只依赖这个接口，不直接依赖具体实现
import type { ToolDefinition } from "@agentforge/shared-types";

// 对话消息 —— 支持简单文本消息和 tool_call 消息
export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

// LLM 流式响应的每个片段
export interface StreamChunk {
  type: "token" | "tool_call" | "done";
  content?: string;
  // Tool call — yielded when LLM requests a tool invocation
  tool_call?: {
    id: string;
    name: string;
    arguments: string; // JSON string of arguments
  };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// 非流式调用的返回结果
export interface ChatSyncResult {
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

// 所有 LLM Provider 必须实现此接口
export interface LLMProvider {
  // 流式聊天：接收消息列表 + 系统提示词 → 逐个 yield token/tool_call 片段
  streamChat(
    messages: ChatMessage[],
    model: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamChunk>;

  // 非流式聊天：用于记忆提取、Rerank、结构化JSON输出等需要完整响应的场景
  // jsonMode: 启用后使用response_format: json_object（OpenAI）或prompt追加JSON指令（其他provider）
  chatSync(
    messages: ChatMessage[],
    model: string,
    systemPrompt?: string,
    temperature?: number,
    maxTokens?: number,
    jsonMode?: boolean,
  ): Promise<ChatSyncResult>;

  // 返回该厂商支持的模型列表
  listModels(): Array<{ id: string; name: string; provider: string; max_tokens: number }>;
}
