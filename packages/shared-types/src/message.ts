export type MessageRole = "system" | "user" | "assistant";

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  model: string;
  created_at: string;
}
