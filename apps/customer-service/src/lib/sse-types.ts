// SSE Chunk 类型定义 —— 客户端子集，对齐服务端 RouteStreamEvent
// 来源：apps/server/src/services/agent-runtime/types.ts
// 注意：仅包含客户端实际消费的类型，服务端内部字段（usage、citation 等）按需保留

import type {
  ContentBlock,
  KnowledgeResult,
  CitationCard,
  TraceStep,
} from "@agentforge/shared-types";

/**
 * SSE 流的事件类型。
 * 后端 RouteStreamEvent 中不包含 tool_call / tool_result ——
 * 这些事件在 Agent Executor 内部被消费，不会透传给前端；
 * 前端需要的过程信息经 citations / trace_step 两个语义化事件下发。
 */
export type SSEDataChunk =
  | SSEMetaChunk
  | SSETokenChunk
  | SSEDoneChunk
  | SSEContentBlockChunk
  | SSECitationsChunk
  | SSETraceStepChunk
  | SSEErrorChunk;

/** 流元信息：会话参数、知识库检索结果、路由意图 */
export interface SSEMetaChunk {
  type: "meta";
  message_id: string;
  session_id: string | null;
  model: string;
  provider: string;
  knowledge: KnowledgeResult[];
  intent: string;
  within_service_hours: boolean;
  memory_count: number;
  route?: string;
  conversational?: boolean;
}

/** 逐字符流式 token */
export interface SSETokenChunk {
  type: "token";
  content: string;
  message_id: string;
}

/** 流结束：包含建议追问、引证校验等可选字段 */
export interface SSEDoneChunk {
  type: "done";
  message_id: string;
  usage: Record<string, unknown>;
  suggestions?: string[];
  memory: { injected: number; extracted: number };
  validated?: boolean;
  fallback_used?: boolean;
  route?: string;
  conversational?: boolean;
  citation?: {
    level: string;
    coverageRate: number;
    avgScore: number;
    uncitedCount: number;
  };
}

/** ToolAgent 产出的结构化卡片 */
export interface SSEContentBlockChunk {
  type: "content_block";
  block: ContentBlock;
  message_id: string;
}

/** 本轮引用文档卡片全集 */
export interface SSECitationsChunk {
  type: "citations";
  items: CitationCard[];
  message_id: string;
}

/** 过程时间轴的单步增量（同名 seq 为同一步的状态更新） */
export interface SSETraceStepChunk {
  type: "trace_step";
  step: TraceStep;
  message_id: string;
}

/** 流错误 */
export interface SSEErrorChunk {
  type: "error";
  content: string;
}
