// Agent Runtime 共享类型
// RouteAgent 接口 + RouteContext + SSE 事件协议

import type { ChatMessage } from "../../providers/types.js";
import type { ContentBlock } from "@agentforge/shared-types";
import type { ExecutionScope } from "../../runtime/scope.js";

// ── 路由分类 ──

export type RouteName = "SAFETY" | "CHAT" | "TASK" | "HUMAN";

export interface RouterDecision {
  route: RouteName;
  confidence: number; // 0.0 ~ 1.0
  reasoning: string; // 简短分类理由，用于审计/debug
  escalationReason?: string; // HUMAN 路由时的升级原因
}

// ── KB 结果 ──

export interface KnowledgeChunkResult {
  content: string;
  score: number;
  docTitle: string;
}

// ── KnowledgeContext 结构化输出 ──

export interface Citation {
  docId: string;
  docTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export interface KBDocumentItem {
  id: string;
  title: string;
  content: string;
}

export interface KnowledgeContext {
  docs: KBDocumentItem[];
  citations: Citation[];
  confidence: number;
  gaps: string[];
  summary: string;
}

// ── Agent 执行上下文 ──

export interface RouteContext {
  conversationId: string;
  sessionId: string | null;
  userMessage: string;
  history: ChatMessage[];
  knowledgeContext: string;
  knowledgeResults: KnowledgeChunkResult[];
  kbChunks: string[]; // 纯文本 chunk，用于校验
  memoryContext: string;
  injectedMemories: string[];
  resolvedModel: string;
  providerName: string;
  withinServiceHours: boolean;
  assistantMsgId: string;
  intent: string;
  /** KnowledgeContext 结构化结果（由 KnowledgeContextBuilder 构建） */
  knowledge?: KnowledgeContext;
}

// ── SSE 流事件 ──

export type RouteStreamEvent =
  | {
      type: "meta";
      message_id: string;
      session_id: string | null;
      model: string;
      provider: string;
      knowledge: KnowledgeChunkResult[];
      intent: string;
      within_service_hours: boolean;
      memory_count: number;
      route?: RouteName;
      conversational?: boolean;
    }
  | {
      type: "token";
      content: string;
      message_id: string;
    }
  | {
      type: "done";
      message_id: string;
      usage: Record<string, unknown>;
      suggestions?: string[];
      memory: { injected: number; extracted: number };
      validated?: boolean;
      fallback_used?: boolean;
      route?: RouteName;
      conversational?: boolean;
      /** Citation 引证校验结果（L4 语义对齐层） */
      citation?: {
        level: string;
        coverageRate: number;
        avgScore: number;
        uncitedCount: number;
      };
    }
  | {
      type: "content_block";
      block: ContentBlock;
      message_id: string;
    }
  | {
      type: "clear_stream";
      message_id: string;
    }
  | {
      type: "error";
      content: string;
    };

// ── RouteAgent 接口 —— 每条路径实现此接口 ──

export interface RouteAgent {
  readonly route: RouteName;
  execute(
    context: RouteContext,
    scope?: ExecutionScope,
  ): AsyncGenerator<RouteStreamEvent>;
}

// ── 共享工具函数 ──

/**
 * 逐字符流式输出文本为 RouteStreamEvent token 事件。
 */
export async function* streamTokens(
  text: string,
  messageId: string,
): AsyncGenerator<RouteStreamEvent> {
  for (const char of text) {
    yield {
      type: "token",
      content: char,
      message_id: messageId,
    };
  }
}

// ── Eval 日志记录 ──

export interface EvalRecord {
  timestamp: string;
  sessionId: string | null;
  userMessage: string;
  kbAvailable: boolean;
  rawResponse: string;
  finalOutput: string | null;
  validationErrors: string[];
  retryCount: number;
  modelUsed: string;
  fallbackUsed: boolean;
  route?: RouteName;
  /** Citation 引证分析 */
  citation?: {
    level: string;
    coverageRate: number;
    avgScore: number;
    uncitedCount: number;
  };
}
