// ── Agent Chat 共享类型 ──
// Agent Runtime 的前后端共享类型定义

import type { ContentBlock } from "./content-block";

// ── 知识库检索结果 ──

export interface KnowledgeResult {
  content: string;
  score: number;
  docTitle: string;
}

// ── Agent 消息 ──

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  knowledge?: KnowledgeResult[];
  /** 从 SSE content_block 解析出的结构化卡片 */
  contentBlocks?: ContentBlock[];
}

// ── 流元信息 ──

export interface AgentStreamMeta {
  messageId: string;
  sessionId: string;
  model: string;
  provider: string;
  knowledge: KnowledgeResult[];
  suggestions?: string[];
  route?: string;
  conversational?: boolean;
}
