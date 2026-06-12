import type {
  ChatRequest,
  ChatStreamChunk,
  Message,
} from "@agentforge/shared-types";
import type { AgentForgeClient } from "../client";

export class ChatService {
  constructor(private client: AgentForgeClient) {}

  send(request: ChatRequest): AsyncGenerator<ChatStreamChunk> {
    return this.client.streamChat(request);
  }

  getMessages(conversationId: string): Promise<Message[]> {
    return this.client.getMessages(conversationId);
  }
}
