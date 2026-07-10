// Team shared types — V9 Multi-Agent System
// Used by both server and frontend

// ---- Agent Role ----

export interface AgentRole {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools: string[];
  maxIterations: number;
  temperature?: number;
  priority: number;
  canDelegate: boolean;
  canBroadcast: boolean;
  outputSchema?: Record<string, unknown>;
}

// ---- Team Definition ----

export type CollaborationMode = "diagnosis";

export type StopCondition = "all_done" | "consensus";

export interface TeamDefinitionVariable {
  type: "string" | "number" | "boolean" | "object" | "array";
  default?: unknown;
  description?: string;
}

export interface TeamDefinition {
  name: string;
  version: string;
  description?: string;
  collaborationMode: CollaborationMode;
  agents: AgentRole[];
  maxTotalIterations: number;
  stopCondition?: StopCondition;
  timeout?: number;
  onFailure?: "stop" | "continue" | "retry";
  variables?: Record<string, TeamDefinitionVariable>;
}

// ---- Agent Message ----

export type AgentMessageType =
  | "task"
  | "result"
  | "question"
  | "clarification"
  | "feedback"
  | "handoff"
  | "broadcast"
  | "status"
  | "error"
  | "done";

export interface AgentMessagePayload {
  task?: string;
  result?: unknown;
  question?: string;
  feedback?: {
    verdict: "pass" | "revise" | "reject";
    score: number;
    issues: Array<{
      severity: string;
      description: string;
      suggestion: string;
    }>;
    summary: string;
  };
  context?: Record<string, unknown>;
  status?: {
    completed: number;
    total: number;
    currentStep?: string;
  };
  error?: {
    message: string;
    code?: string;
    recoverable: boolean;
  };
}

export interface AgentMessage {
  id: string;
  teamRunId: string;
  from: string;
  to: string | "broadcast" | "orchestrator";
  type: AgentMessageType;
  payload: AgentMessagePayload;
  timestamp: string;
  replyTo?: string;
  correlationId?: string;
}

// ---- Blackboard ----

export interface BlackboardEntry {
  key: string;
  value: unknown;
  writtenBy: string;
  timestamp: string;
  version: number;
  metadata?: {
    description?: string;
    tags?: string[];
    ttl?: number;
  };
}

// ---- Team Stream Events ----

export type TeamStreamEventType =
  | "team_started"
  | "team_round_start"
  | "agent_started"
  | "agent_think"
  | "agent_plan"
  | "agent_act"
  | "agent_observe"
  | "agent_message"
  | "blackboard_update"
  | "agent_completed"
  | "agent_error"
  | "team_completed"
  | "team_failed";

export interface TeamStartedEvent {
  type: "team_started";
  teamRunId: string;
  teamName: string;
  mode: CollaborationMode;
  agents: Array<{ name: string; role: string }>;
}

export interface TeamRoundStartEvent {
  type: "team_round_start";
  roundNumber: number;
  totalRounds: number;
}

export interface TeamAgentStartedEvent {
  type: "agent_started";
  agentName: string;
  role: string;
  task: string;
}

export interface TeamAgentMessageEvent {
  type: "agent_message";
  from: string;
  to: string;
  msgType: AgentMessageType;
  payload: AgentMessagePayload;
  timestamp: string;
}

export interface TeamBlackboardUpdateEvent {
  type: "blackboard_update";
  key: string;
  value: unknown;
  writtenBy: string;
  version: number;
}

export interface TeamAgentCompletedEvent {
  type: "agent_completed";
  agentName: string;
  output: unknown;
  durationMs: number;
}

export interface TeamAgentErrorEvent {
  type: "agent_error";
  agentName: string;
  error: string;
}

export interface TeamCompletedEvent {
  type: "team_completed";
  output: unknown;
  totalDurationMs: number;
  roundsCount: number;
}

export interface TeamFailedEvent {
  type: "team_failed";
  error: string;
}

// Generic wrapper for agent events forwarded to team stream
export interface TeamAgentForwardedEvent {
  type: "agent_think" | "agent_plan" | "agent_act" | "agent_observe";
  agentName: string;
  [key: string]: unknown;
}

export type TeamStreamEvent =
  | TeamStartedEvent
  | TeamRoundStartEvent
  | TeamAgentStartedEvent
  | TeamAgentForwardedEvent
  | TeamAgentMessageEvent
  | TeamBlackboardUpdateEvent
  | TeamAgentCompletedEvent
  | TeamAgentErrorEvent
  | TeamCompletedEvent
  | TeamFailedEvent;

// ---- DTOs ----

export interface TeamDTO {
  id: string;
  userId: string;
  name: string;
  description?: string;
  definition: TeamDefinition;
  version: number;
  status: string;
  tags: string[];
  runCount: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRunDTO {
  id: string;
  teamId: string;
  userId: string;
  conversationId?: string;
  task: string;
  status: string;
  mode: CollaborationMode;
  messages: AgentMessage[];
  blackboard: Record<string, unknown>;
  checkpoint?: unknown;
  output?: Record<string, unknown>;
  error?: string;
  roundsCount: number;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
}

// ---- Team Template ----

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  definition: TeamDefinition;
}
