export type MessageRole = "system" | "user" | "assistant";

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  model: string;
  created_at: string;
}

export interface CreateMessageDTO {
  role: MessageRole;
  content: string;
  model?: string;
}

export interface ChatRequest {
  conversation_id: string;
  message: string;
  model?: string;
  kb_ids?: string[] | null;
  tools?: string[] | null;
}

export interface ChatStreamChunk {
  type: "meta" | "token" | "done" | "error" | "tool_call" | "tool_result";
  content?: string;
  message_id?: string;
  model?: string;
  provider?: string;
  memory_count?: number;
  knowledge_count?: number;
  knowledge?: Array<{ content: string; score: number; docTitle: string }>;
  tools_enabled?: string[];
  tool_call?: {
    id: string;
    name: string;
    arguments: string;
  };
  tool_result?: {
    tool_call_id: string;
    name: string;
    result: string;
  };
  tool_calls_count?: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    latency_ms?: number;
    first_token_ms?: number;
  };
  memory?: {
    injected: number;
    extracted: number;
  };
}
