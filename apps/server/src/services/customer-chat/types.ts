// 客服 Agent Router 共享类型
// RouteAgent 接口 + RouteContext + SSE 事件协议

import type { ChatMessage } from "../../providers/types.js";
import type { ContentBlock } from "@agentforge/shared-types";

// ── 路由分类 ──

export type RouteName = "SAFETY" | "SMALL_TALK" | "TOOL" | "HUMAN";

export interface RouterDecision {
  route: RouteName;
  confidence: number; // 0.0 ~ 1.0
  reasoning: string; // 简短分类理由，用于审计/debug
  /** Intent Classifier 推荐的工具列表（空数组 = 无需工具，直接回复） */
  tools?: string[];
  /** 工具执行顺序：parallel（无依赖，可并行）| sequential（按顺序，后一个依赖前一个结果） */
  execution_order?: "parallel" | "sequential";
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
  /** Intent Classifier 推荐的工具列表（Agent 可自行决定是否采纳） */
  toolHints?: string[];
  /** 推荐的工具执行顺序 */
  executionHint?: "parallel" | "sequential";
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
      type: "content_block";
      block: ContentBlock;
      message_id: string;
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

// ── 共享工具函数 ──

/**
 * 逐字符流式输出文本为 RouteStreamEvent token 事件。
 * 复用 SafetyAgent、SmallTalkAgent、HumanAgent 中的重复流式逻辑。
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
  /** Citation 引证分析（L4 升级后新增） */
  citation?: {
    level: string;
    coverageRate: number;
    avgScore: number;
    uncitedCount: number;
  };
}
