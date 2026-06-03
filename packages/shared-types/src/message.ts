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
}

export interface ChatStreamChunk {
  type: "meta" | "token" | "done" | "error";
  content?: string;
  message_id?: string;
  model?: string;
  provider?: string;
  memory_count?: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  memory?: {
    injected: number;
    extracted: number;
  };
}
