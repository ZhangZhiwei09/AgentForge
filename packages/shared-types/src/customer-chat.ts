// ── 智能客服共享类型 ──
// 统一 KnowledgeResult, ToolCallRecord, CSMessage 等类型定义
// 避免在 useCustomerChatStream / CustomerChat / CustomerChatPage 中重复定义

import type { ContentBlock } from "./content-block";

// ── 知识库检索结果 ──

export interface KnowledgeResult {
  content: string;
  score: number;
  docTitle: string;
}

// ── 工具调用记录 ──

export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "pending" | "done" | "error";
}

// ── 客服消息 ──

export interface CSMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  knowledge?: KnowledgeResult[];
  toolCalls?: ToolCallRecord[];
  /** 从 markdown fence 或 SSE content_block 解析出的结构化卡片 */
  contentBlocks?: ContentBlock[];
}

// ── 流元信息 ──

export interface CSStreamMeta {
  messageId: string;
  sessionId: string;
  model: string;
  provider: string;
  knowledge: KnowledgeResult[];
  suggestions?: string[];
  route?: string;
  conversational?: boolean;
}
