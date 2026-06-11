// Agent types — shared between frontend and backend for P1-3 Agent Reasoning + P1-4 Working Memory

// ---- Agent Decision Types ----

export type AgentDecision =
  | {
      action: "tool_call";
      tool: string;
      args: Record<string, unknown>;
      reason: string;
    }
  | {
      action: "respond";
      content: string;
      summary: string;
    }
  | {
      action: "ask_user";
      question: string;
      context: string;
    };

// ---- Agent Step (Scratchpad Entry) ----

export interface AgentStep {
  step: number;
  observation: string;
  analysis: string;
  plan: string;
  decision: AgentDecision;
  result?: string;
  timestamp: string;
}

// ---- Agent Session ----

export interface AgentSessionDTO {
  id: string;
  conversationId: string;
  task: string;
  status: "running" | "paused" | "completed" | "failed";
  scratchpad: AgentStep[];
  finalSummary?: string | null;
  startedAt: string;
  completedAt?: string | null;
}

// ---- Agent Run Request ----

export interface AgentRunRequest {
  conversation_id: string;
  task: string;
  model?: string | null;
  max_iterations?: number;
  tools?: string[] | null;
}

// ---- Agent Respond Request (for ask_user pauses) ----

export interface AgentRespondRequest {
  session_id: string;
  response: string;
}

// ---- SSE Stream Event Types ----

export interface AgentThinkEvent {
  type: "agent_think";
  step: number;
  observation: string;
  analysis: string;
  plan: string;
}

export interface AgentActEvent {
  type: "agent_act";
  step: number;
  decision: AgentDecision;
}

export interface AgentObserveEvent {
  type: "agent_observe";
  step: number;
  result: string;
}

export interface AgentTokenEvent {
  type: "agent_token";
  content: string;
  message_id: string;
}

export interface AgentRespondEvent {
  type: "agent_respond";
  content: string;
  summary: string;
  message_id: string;
}

export interface AgentAskUserEvent {
  type: "agent_ask_user";
  question: string;
  context: string;
  session_id: string;
}

export interface AgentErrorEvent {
  type: "agent_error";
  error: string;
  step: number;
}

export interface AgentClearStreamEvent {
  type: "agent_clear_stream";
  message_id: string;
  step: number;
}

export interface AgentDoneEvent {
  type: "agent_done";
  total_steps: number;
  final_summary: string;
  session_id: string;
}

export interface AgentMetaEvent {
  type: "agent_meta";
  session_id: string;
  model: string;
  provider: string;
  max_iterations: number;
  tools_enabled?: string[];
}

// ---- P1-5 Approval Event Types ----

export interface AgentApprovalRequiredEvent {
  type: "agent_approval_required";
  approval_id: string;
  session_id: string;
  step: number;
  tool_name: string;
  tool_args: Record<string, unknown>;
  risk_level: string;
  reason: string;
  timeout_ms: number;
}

export interface AgentApprovalResultEvent {
  type: "agent_approval_result";
  approval_id: string;
  session_id: string;
  step: number;
  status: "approved" | "rejected" | "timed_out";
  modified_args?: Record<string, unknown>;
  rejection_reason?: string;
  result?: string;
}

export interface AgentApprovalDTO {
  id: string;
  sessionId: string;
  stepNumber: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  riskLevel: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "timed_out";
  approvedBy?: string | null;
  modifiedArgs?: Record<string, unknown> | null;
  rejectionReason?: string | null;
  requestedAt: string;
  decidedAt?: string | null;
}

export interface AgentApprovalRequest {
  session_id: string;
  approval_id: string;
  action: "approve" | "reject";
  modified_args?: Record<string, unknown>;
  rejection_reason?: string;
}

// Union type for all agent stream events
export type AgentStreamEvent =
  | AgentMetaEvent
  | AgentThinkEvent
  | AgentActEvent
  | AgentObserveEvent
  | AgentTokenEvent
  | AgentRespondEvent
  | AgentAskUserEvent
  | AgentClearStreamEvent
  | AgentErrorEvent
  | AgentDoneEvent
  | AgentApprovalRequiredEvent
  | AgentApprovalResultEvent;
