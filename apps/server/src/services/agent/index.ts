// AgentService — Facade for Agent Runner.
//
// All callers (AgentExecutor, routes/agent.ts, workflows, teams) use this
// class exclusively — never the runner implementation directly.

import { LegacyAgentRunner } from "./runner/legacy-agent-runner.js";
import type { AgentStreamEvent, AgentStep } from "@agentforge/shared-types";
import type { ExecutionScope } from "../../runtime/scope.js";
import type { AgentGuardConfig } from "../agent-guard.js";

export class AgentService {
  private runner = new LegacyAgentRunner();

  // ── run ───────────────────────────────────────────────

  async *run(
    conversationId: string,
    task: string,
    options: {
      model?: string | null;
      maxIterations?: number;
      tools?: string[] | null;
      guardConfig?: Partial<AgentGuardConfig> | null;
      scope?: ExecutionScope;
      skipUserMessageSave?: boolean;
      skipAssistantMessageSave?: boolean;
    } = {},
  ): AsyncGenerator<AgentStreamEvent> {
    yield* this.runner.run(conversationId, task, options);
  }

  // ── resume ────────────────────────────────────────────

  async *resume(
    sessionId: string,
    userResponse: string,
    scope?: ExecutionScope,
  ): AsyncGenerator<AgentStreamEvent> {
    yield* this.runner.resume(sessionId, userResponse, scope);
  }

  // ── handleApproval ────────────────────────────────────

  async *handleApproval(
    sessionId: string,
    approvalId: string,
    action: "approve" | "reject",
    modifiedArgs?: Record<string, unknown>,
    rejectionReason?: string,
    scope?: ExecutionScope,
  ): AsyncGenerator<AgentStreamEvent> {
    yield* this.runner.handleApproval(
      sessionId,
      approvalId,
      action,
      modifiedArgs,
      rejectionReason,
      scope,
    );
  }

  // ── Queries ───────────────────────────────────────────

  async getSessions(conversationId: string): Promise<
    Array<{
      id: string;
      conversationId: string;
      task: string;
      status: string;
      scratchpad: AgentStep[];
      finalSummary: string | null;
      runtimeState: Record<string, unknown> | null;
      startedAt: Date;
      completedAt: Date | null;
    }>
  > {
    return this.runner.getSessions(conversationId);
  }

  async getSession(id: string): Promise<{
    id: string;
    conversationId: string;
    task: string;
    status: string;
    scratchpad: AgentStep[];
    finalSummary: string | null;
    runtimeState: Record<string, unknown> | null;
    startedAt: Date;
    completedAt: Date | null;
  } | null> {
    return this.runner.getSession(id);
  }
}
