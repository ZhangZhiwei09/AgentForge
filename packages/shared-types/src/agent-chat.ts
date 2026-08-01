// ── Agent Chat 共享类型 ──
// Agent Runtime 的前后端共享类型定义

import type { ContentBlock } from "./content-block";

// ── 知识库检索结果 ──

export interface KnowledgeResult {
  content: string;
  score: number;
  docTitle: string;
}

// ── 诊断信息采集（信息不足时提示用户补充） ──

export interface ClarificationRequest {
  intent: string;
  missingFields: string[];
  promptMessage: string;
  hints: string[];
}

// ── HITL 等待补充（诊断进行中的阶段边界暂停） ──

export interface WaitingInputRequest {
  message: string;
  missingFields: string[];
}

// ── 诊断进度（多 Agent 协同诊断） ──

export interface DiagnosisPhase {
  phase: number; // 1 | 2 | 3
  label: string; // "前端排查" | "后端排查" | "综合分析"
  agent: string; // "frontend_agent" | "backend_agent" | "leader"
  status: "pending" | "running" | "done";
  summary?: string; // 完成后的一句话摘要
}

export interface DiagnosisProgress {
  status: "running" | "done" | "error";
  phases: DiagnosisPhase[];
  resolution?: string; // "frontend_only" | "adopt_frontend" | "adopt_backend" | "divergent" | "needs_human"
  finalConclusion?: string; // 最终诊断结论文本
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
  /** 诊断信息采集请求（信息不足时提示用户补充） */
  clarification?: ClarificationRequest;
  /** 多 Agent 协同诊断过程数据 */
  diagnosis?: DiagnosisProgress;
  /** HITL 等待补充请求（诊断进行中暂停，用户补充后同 thread 续跑） */
  waitingInput?: WaitingInputRequest;
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
