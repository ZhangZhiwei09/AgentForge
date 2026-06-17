// Workflow DTO helpers — pure functions to convert Prisma records to API DTOs
import type { Prisma } from "@agentforge/database";
import type {
  WorkflowDTO,
  WorkflowRunDTO,
  WorkflowStepLogDTO,
  WorkflowDefinition,
  WorkflowCheckpoint,
  ProgressSummary,
} from "@agentforge/shared-types";
import { WorkflowCheckpointSchema } from "./schema.js";
import { logger } from "@agentforge/logger";

/**
 * Safely parse a raw checkpoint from the JSONB column.
 * Returns undefined on missing, corrupt, or schema-mismatched data.
 */
function safeParseCheckpoint(raw: unknown): WorkflowCheckpoint | undefined {
  if (!raw) return undefined;
  const result = WorkflowCheckpointSchema.safeParse(raw);
  if (!result.success) {
    logger.warn(
      { issues: result.error.issues },
      "Corrupted checkpoint data in DB, returning undefined",
    );
    return undefined;
  }
  // Zod inference produces a structurally identical but nominally distinct type.
  // The single cast is safe: WorkflowCheckpointSchema guarantees runtime shape matches WorkflowCheckpoint.
  return result.data as WorkflowCheckpoint;
}

export function toDTO(
  w: Prisma.WorkflowGetPayload<Record<string, never>>,
): WorkflowDTO {
  return {
    id: w.id,
    userId: w.userId,
    name: w.name,
    description: w.description || undefined,
    definition: w.definition as unknown as WorkflowDefinition,
    version: w.version,
    status: w.status as WorkflowDTO["status"],
    tags: w.tags || [],
    runCount: w.runCount || 0,
    lastRunAt: w.lastRunAt?.toISOString(),
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}

export function runToDTO(
  r: Prisma.WorkflowRunGetPayload<Record<string, never>>,
): WorkflowRunDTO {
  return {
    id: r.id,
    workflowId: r.workflowId,
    userId: r.userId,
    status: r.status as WorkflowRunDTO["status"],
    input: (r.input as Record<string, unknown>) || {},
    output: (r.output as Record<string, unknown>) || undefined,
    checkpoint: safeParseCheckpoint(r.checkpoint),
    currentStepId: r.currentStepId || undefined,
    progress: (r.progress as unknown as ProgressSummary) || {
      completed: 0,
      total: 0,
      failed: 0,
      skipped: 0,
      running: 0,
    },
    error: r.error || undefined,
    durationMs: r.durationMs || undefined,
    startedAt: r.startedAt.toISOString(),
    completedAt: r.completedAt?.toISOString(),
  };
}

export function stepLogToDTO(
  sl: Prisma.WorkflowStepLogGetPayload<Record<string, never>>,
): WorkflowStepLogDTO {
  return {
    id: sl.id,
    runId: sl.runId,
    stepId: sl.stepId,
    stepType: sl.stepType as WorkflowStepLogDTO["stepType"],
    status: sl.status as WorkflowStepLogDTO["status"],
    input: (sl.input as Record<string, unknown>) || undefined,
    output: (sl.output as Record<string, unknown>) || undefined,
    error: sl.error || undefined,
    retryCount: sl.retryCount || 0,
    durationMs: sl.durationMs || undefined,
    tokensUsed: sl.tokensUsed || 0,
    events: (sl.events as unknown[]) || [],
    startedAt: sl.startedAt?.toISOString(),
    completedAt: sl.completedAt?.toISOString(),
  };
}
