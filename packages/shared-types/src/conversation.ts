export interface Conversation {
  id: string;
  title: string;
  user_id: string;
  created_at: string;
  updated_at: string;
}

export interface CreateConversationDTO {
  title?: string;
}

export interface UpdateConversationDTO {
  title?: string;
}
