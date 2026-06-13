// 客服 Agent Router 共享类型
// RouteAgent 接口 + RouteContext + SSE 事件协议

import type { ChatMessage } from "../../providers/types.js";

// ── 路由分类 ──

export type RouteName = "SAFETY" | "SMALL_TALK" | "BUSINESS" | "TOOL" | "HUMAN";

export interface RouterDecision {
  route: RouteName;
  confidence: number; // 0.0 ~ 1.0
  reasoning: string; // 简短分类理由，用于审计/debug
  suggestedTools?: string[]; // TOOL 路由时推荐的工具名列表
  escalationReason?: string; // HUMAN 路由时的升级原因
}

// ── KB 结果 ──

export interface KnowledgeChunkResult {
  content: string;
  score: number;
  docTitle: string;
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
}

// ── SSE 流事件（与现有 customer-chat SSE 协议兼容） ──

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
    }
  | {
      type: "error";
      content: string;
    };

// ── RouteAgent 接口 —— 每条路径实现此接口 ──

export interface RouteAgent {
  readonly route: RouteName;
  execute(context: RouteContext): AsyncGenerator<RouteStreamEvent>;
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
}
