// 数据管理模块共享类型 —— Knowledge Base / Analytics / Feedback DTOs

// ── 知识库 ──

export interface KnowledgeBaseDTO {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  document_count: number;
  created_at: string;
  updated_at: string;
}

export interface CreateKnowledgeBaseRequest {
  name: string;
  description?: string | null;
}

export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string | null;
  enabled?: boolean;
}

// ── 文档 ──

export interface KnowledgeDocumentDTO {
  id: string;
  knowledgeBaseId: string;
  title: string;
  content: string;
  chunkCount: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDocumentRequest {
  title: string;
  content: string;
}

export interface BatchCreateDocumentsRequest {
  documents: CreateDocumentRequest[];
}

// ── 搜索 ──

export interface KnowledgeSearchRequest {
  query: string;
  kb_ids?: string[] | null;
  top_k?: number;
}

export interface KnowledgeSearchResultDTO {
  chunkId: string;
  docId: string;
  kbId: string;
  content: string;
  score: number;
  chunkIndex: number;
  docTitle: string;
}

export interface KnowledgeSearchResponse {
  results: KnowledgeSearchResultDTO[];
  query: string;
  total: number;
}

// ── 统计 ──

export interface KnowledgeStatsDTO {
  knowledge_bases: number;
  documents: number;
  chunks: number;
  milvus: Record<string, unknown> | null;
}

// ── 数据分析 ──

export interface AnalyticsDTO {
  total_conversations: number;
  today_conversations: number;
  total_messages: number;
  satisfaction_rate: number;
  total_ratings: number;
}

// ── 反馈 ──

export interface FeedbackDTO {
  id: string;
  rating: string;
  comment: string | null;
  created_at: string;
  conversation_id: string;
  session_id: string;
  intent: string | null;
  user_message: string;
  assistant_message: string;
  message_id: string;
}

export interface FeedbackQueryParams {
  type?: "all" | "positive" | "negative";
  page?: number;
  limit?: number;
}

export interface FeedbackResponse {
  feedback: FeedbackDTO[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ── FAQ ──

export interface FAQDocumentDTO {
  id: string;
  title: string;
  chunkCount: number;
  status: string;
  createdAt: string;
}

export interface FAQCategoryDTO {
  name: string;
  count: number;
}
