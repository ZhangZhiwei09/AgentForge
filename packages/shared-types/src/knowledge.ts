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
  // 分块配置（可被 KB 级别覆盖）
  chunk_size_tokens?: number | null;
  chunk_overlap_tokens?: number | null;
  separator_mode?: string | null;
  custom_separator?: string | null;
  chunk_structure?: string | null;
  child_chunk_size_tokens?: number | null;
  child_chunk_overlap_tokens?: number | null;
  remove_extra_spaces?: boolean | null;
  remove_urls_emails?: boolean | null;
}

export interface CreateKnowledgeBaseRequest {
  name: string;
  description?: string | null;
}

export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  // 分块配置
  chunk_size_tokens?: number | null;
  chunk_overlap_tokens?: number | null;
  separator_mode?: string | null;
  custom_separator?: string | null;
  chunk_structure?: string | null;
  child_chunk_size_tokens?: number | null;
  child_chunk_overlap_tokens?: number | null;
  remove_extra_spaces?: boolean | null;
  remove_urls_emails?: boolean | null;
}

// ── 分块 ──

export interface KnowledgeChunkDTO {
  id: string;
  documentId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  sourceType: string | null;
  qualityLabel: string | null;
  parentChunkId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
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
  // V2.2: 文件上传元数据（可选）
  originalFilename?: string | null;
  originalFileType?: string | null;
  originalFileSize?: number | null;
  // V2.2: 失败原因与质量标签（可选）
  errorMessage?: string | null;
  qualityLabel?: string | null;
  retryCount?: number;
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

// ── 分块配置 ──

export interface ChunkingConfigDTO {
  mode: 'general' | 'parent_child';
  separator: string;
  maxChunkSize: number;
  overlap: number;
  removeExtraSpaces: boolean;
  removeUrlsEmails: boolean;
  // 父子模式
  parentMaxSize?: number;
  childMaxSize?: number;
}

// ── 分块预览 ──

export interface ChunkPreviewDTO {
  index: number;
  content: string;
  tokenCount: number;
}

export interface ChunkPreviewResponseDTO {
  chunkStructure: string;
  total: number;
  preview: ChunkPreviewDTO[];
}

// ── 命中测试 ──

export interface HitTestingRequestDTO {
  query: string;
  topK?: number;
  searchMethod?: 'hybrid' | 'semantic' | 'keyword';
  rerankingEnable?: boolean;
  scoreThreshold?: number;
}

export interface HitTestingResultDTO {
  chunkId: string;
  content: string;
  score: number;
  fusionScore?: number;
  rerankScore?: number;
  recallSources: string[];
  chunkIndex: number;
  document: {
    id: string;
    title: string;
  };
  parentChunk?: {
    id: string;
    content: string;
  };
}

export interface HitTestingResponseDTO {
  query: { content: string };
  results: HitTestingResultDTO[];
  elapsedMs: number;
}
