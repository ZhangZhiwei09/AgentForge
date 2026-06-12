// Step Handler Types — interfaces shared by all step handlers
import type { WorkflowStep, StepResult } from "@agentforge/shared-types";
import type { VariableContext } from "../variable-resolver.js";

export interface StepContext {
  runId: string;
  conversationId: string;
  variables: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  userId: string;
  emit: (event: unknown) => void;
  pauseForApproval: (
    stepId: string,
    message: string,
    details: Record<string, unknown> | undefined,
    timeoutMs: number,
  ) => Promise<ApprovalDecision>;
}

export interface ApprovalDecision {
  action: "approved" | "rejected" | "timed_out";
  modifiedArgs?: Record<string, unknown>;
  rejectionReason?: string;
}

export interface StepHandler {
  execute(step: WorkflowStep, context: StepContext): Promise<StepResult>;
}

export type { VariableContext };
