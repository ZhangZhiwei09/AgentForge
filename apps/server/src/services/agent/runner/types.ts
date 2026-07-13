// AgentRunner interface — The contract all agent runner implementations must satisfy.

import type { AgentStreamEvent } from "@agentforge/shared-types";
import type { ExecutionScope } from "../../../runtime/scope.js";
import type { AgentGuardConfig } from "../../agent-guard.js";
import type { AgentStep } from "@agentforge/shared-types";

// ── Run Options ─────────────────────────────────────────

export interface AgentRunOptions {
  model?: string | null;
  maxIterations?: number;
  tools?: string[] | null;
  guardConfig?: Partial<AgentGuardConfig> | null;
  scope?: ExecutionScope;
  skipUserMessageSave?: boolean;
  skipAssistantMessageSave?: boolean;
}

// ── Agent Runner Interface ──────────────────────────────

export interface AgentRunner {
  /** Run the ReAct agent loop for a given task. Yields AgentStreamEvent chunks. */
  run(
    conversationId: string,
    task: string,
    options?: AgentRunOptions,
  ): AsyncGenerator<AgentStreamEvent>;

  /** Resume a paused agent session with the user's response. */
  resume(
    sessionId: string,
    userResponse: string,
    scope?: ExecutionScope,
  ): AsyncGenerator<AgentStreamEvent>;

  /** Handle an approval decision (approve/reject) for a paused agent session. */
  handleApproval(
    sessionId: string,
    approvalId: string,
    action: "approve" | "reject",
    modifiedArgs?: Record<string, unknown>,
    rejectionReason?: string,
    scope?: ExecutionScope,
  ): AsyncGenerator<AgentStreamEvent>;

  /** Get agent sessions for a conversation. */
  getSessions(conversationId: string): Promise<
    Array<{
      id: string;
      conversationId: string;
      task: string;
      status: string;
      scratchpad: AgentStep[];
      finalSummary: string | null;
      startedAt: Date;
      completedAt: Date | null;
    }>
  >;

  /** Get a single agent session by ID. */
  getSession(id: string): Promise<{
    id: string;
    conversationId: string;
    task: string;
    status: string;
    scratchpad: AgentStep[];
    finalSummary: string | null;
    startedAt: Date;
    completedAt: Date | null;
  } | null>;
}


