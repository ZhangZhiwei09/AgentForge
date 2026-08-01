// Checkpoint Data — interface and builder function for workflow execution state persistence
import type { StepResult } from "@agentforge/shared-types";

export interface CheckpointData {
  runId: string;
  workflowId: string;
  completedSteps: string[];
  currentStep: string | null;
  pendingSteps: string[];
  stepLogs: StepResult[];
  variables: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  savedAt: string;
  totalSteps: number;
}

/**
 * Build a checkpoint from the current execution state.
 */
export function buildCheckpoint(
  runId: string,
  workflowId: string,
  completedStepIds: string[],
  pendingStepIds: string[],
  stepLogs: StepResult[],
  variables: Record<string, unknown>,
  stepResults: Record<string, unknown>,
  totalSteps: number,
): CheckpointData {
  return {
    runId,
    workflowId,
    completedSteps: completedStepIds,
    currentStep: pendingStepIds[0] || null,
    pendingSteps: pendingStepIds,
    stepLogs,
    variables,
    stepResults,
    savedAt: new Date().toISOString(),
    totalSteps,
  };
}
