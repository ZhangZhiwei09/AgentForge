import type {
  Conversation,
  CreateConversationDTO,
} from "@agentforge/shared-types";
import type { AgentForgeClient } from "../client";

export class ConversationService {
  constructor(private client: AgentForgeClient) {}

  create(dto?: CreateConversationDTO) {
    return this.client.createConversation(dto);
  }

  list() {
    return this.client.listConversations();
  }

  get(id: string) {
    return this.client.getConversation(id);
  }

  delete(id: string) {
    return this.client.deleteConversation(id);
  }
}
