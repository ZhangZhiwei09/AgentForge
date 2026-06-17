// Workflow Service — main orchestrator for the V6 Workflow Engine
// Manages workflow CRUD, execution, checkpoints, and SSE streaming
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import type { ExecutionScope } from "../runtime/scope.js";
import { DAGExecutor } from "./dag-executor.js";
import type { CheckpointData, DAGExecutionContext } from "./dag-executor.js";
import { WorkflowDefinitionSchema, CreateWorkflowSchema } from "./schema.js";
import { toDTO, runToDTO, stepLogToDTO } from "./dto.js";
import {
  findWorkflowById,
  findRunById,
  listWorkflows,
  listRunsForWorkflow,
  findRunWithLogs,
} from "./queries.js";
import type { Prisma } from "@agentforge/database";
import type {
  WorkflowDefinition,
  WorkflowDTO,
  WorkflowRunDTO,
  WorkflowStepLogDTO,
  StepResult,
  ProgressSummary,
} from "@agentforge/shared-types";

// ---- Types ----

interface PendingApproval {
  resolve: (decision: {
    action: "approved" | "rejected" | "timed_out";
    modifiedArgs?: Record<string, unknown>;
  }) => void;
  timeout: ReturnType<typeof setTimeout>;
  stepId: string;
}

// ---- Workflow Service ----

export class WorkflowService {
  private dagExecutor: DAGExecutor;
  private pendingApprovals: Map<string, PendingApproval> = new Map();
  /** Active workflow generators keyed by runId — enables real resume after pause */
  private runningGenerators: Map<string, AsyncGenerator<unknown>> = new Map();

  constructor() {
    this.dagExecutor = new DAGExecutor();
  }

  // ========== CRUD ==========

  /** Create a new workflow */
  async create(userId: string, data: unknown): Promise<WorkflowDTO> {
    const parsed = CreateWorkflowSchema.parse(data);
    const id = randomUUID();

    const workflow = await prisma.workflow.create({
      data: {
        id,
        userId,
        name: parsed.name,
        description: parsed.description || null,
        definition: parsed.definition as object,
        status: "draft",
        tags: parsed.tags || [],
      },
    });

    return toDTO(workflow);
  }

  /** List workflows for a user */
  async list(
    userId: string,
    options: {
      status?: string;
      tag?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<{ items: WorkflowDTO[]; total: number; page: number }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const where: Prisma.WorkflowWhereInput = { userId };

    if (options.status) {
      where.status = options.status;
    }
    if (options.tag) {
      where.tags = { has: options.tag };
    }

    const [workflows, total] = await listWorkflows(where, page, limit);

    return {
      items: workflows.map((w) => toDTO(w)),
      total,
      page,
    };
  }

  /** Get a single workflow by ID */
  async get(workflowId: string, userId: string): Promise<WorkflowDTO | null> {
    const workflow = await findWorkflowById(workflowId, userId);
    if (!workflow) return null;
    return toDTO(workflow);
  }

  /** Update a workflow definition */
  async update(
    workflowId: string,
    userId: string,
    data: Record<string, unknown>,
  ): Promise<WorkflowDTO | null> {
    const workflow = await findWorkflowById(workflowId, userId);
    if (!workflow) return null;

    const updateData: Record<string, unknown> = {};

    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.tags !== undefined) updateData.tags = data.tags;
    if (data.definition !== undefined) {
      // Validate the definition before saving
      WorkflowDefinitionSchema.parse(data.definition);
      updateData.definition = data.definition;
      updateData.version = { increment: 1 };
    }

    const updated = await prisma.workflow.update({
      where: { id: workflowId },
      data: updateData,
    });

    return toDTO(updated);
  }

  /** Delete a workflow */
  async delete(workflowId: string, userId: string): Promise<boolean> {
    const workflow = await findWorkflowById(workflowId, userId);
    if (!workflow) return false;

    await prisma.workflow.delete({ where: { id: workflowId } });
    return true;
  }

  /** Validate a workflow definition without saving */
  validateDefinition(definition: unknown): {
    valid: boolean;
    errors?: Array<{ path: string; message: string }>;
  } {
    try {
      WorkflowDefinitionSchema.parse(definition);
      return { valid: true };
    } catch (err: unknown) {
      const issues = err instanceof Error && "issues" in err
        ? (err as unknown as { issues: Array<{ path?: (string | number)[]; message?: string }> }).issues
        : undefined;
      const errors =
        issues?.map((issue) => ({
          path: issue.path?.join(".") || "",
          message: issue.message || "Unknown validation error",
        })) || [];
      return { valid: false, errors };
    }
  }

  // ========== Execution ==========

  /** Run a workflow and stream events */
  async *runWorkflow(
    workflowId: string,
    userId: string,
    inputVariables: Record<string, unknown>,
    conversationId?: string,
    scope?: ExecutionScope,
  ): AsyncGenerator<unknown> {
    const startTime = Date.now();
    const workflow = await findWorkflowById(workflowId, userId);
    if (!workflow) {
      yield { type: "workflow_failed", error: "Workflow not found" };
      return;
    }

    const definition = workflow.definition as unknown as WorkflowDefinition;

    // Create run record
    const runId = randomUUID();
    const totalSteps = definition.steps.length;

    await prisma.workflowRun.create({
      data: {
        id: runId,
        workflowId,
        userId,
        status: "running",
        input: inputVariables as object,
        progress: {
          completed: 0,
          total: totalSteps,
          failed: 0,
          skipped: 0,
          running: 0,
        },
      },
    });

    // Set up context
    const variables: Record<string, unknown> = {};
    if (definition.variables) {
      for (const [key, def] of Object.entries(definition.variables)) {
        variables[key] = inputVariables[key] ?? def.default;
      }
    }

    const stepResults: Record<string, unknown> = {};
    const completedStepIds: string[] = [];
    const stepStatuses = new Map<string, "completed" | "failed" | "skipped">();
    const allStepIds = definition.steps.map((s) => s.id);

    // Approval handler
    const pendingApprovals = this.pendingApprovals;

    const context: DAGExecutionContext = {
      runId,
      conversationId: conversationId || "",
      variables,
      stepResults,
      userId,
      definition,
      scope,
      emit: (event: unknown) => {
        // Events are yielded by the generator, not emitted here
        // This is a placeholder for internal use
      },
      pauseForApproval: (stepId, message, details, timeoutMs) => {
        return new Promise((resolve) => {
          const key = `${runId}:${stepId}`;
          const timeout = setTimeout(() => {
            const pending = pendingApprovals.get(key);
            if (pending) {
              pendingApprovals.delete(key);
              pending.resolve({ action: "timed_out" as const });
            }
          }, timeoutMs);

          pendingApprovals.set(key, { resolve, timeout, stepId });
        });
      },
    };

    // Update run status to running
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "running", currentStepId: allStepIds[0] },
    });

    try {
      for await (const event of this.dagExecutor.execute(context)) {
        const ev = event as Record<string, string>;

        // Save step logs on completion/failure
        if (
          ev.type === "workflow_step_completed" ||
          ev.type === "workflow_step_failed"
        ) {
          const stepId = ev.stepId;
          if (stepId) {
            completedStepIds.push(stepId);
            // Track step status independently from stepResults (which stores raw output)
            const status: "completed" | "failed" | "skipped" =
              ev.type === "workflow_step_failed"
                ? "failed"
                : (ev as any).status === "skipped"
                  ? "skipped"
                  : "completed";
            stepStatuses.set(stepId, status);
          }

          // Update run progress
          const progress: ProgressSummary = {
            completed: completedStepIds.filter((id) => stepStatuses.get(id) === "completed").length,
            total: totalSteps,
            failed: completedStepIds.filter((id) => stepStatuses.get(id) === "failed").length,
            skipped: completedStepIds.filter((id) => stepStatuses.get(id) === "skipped").length,
            running: 0,
          };

          await prisma.workflowRun.update({
            where: { id: runId },
            data: {
              progress: progress as any,
              currentStepId: stepId,
              checkpoint: this.dagExecutor.buildCheckpoint(
                runId,
                workflowId,
                completedStepIds,
                allStepIds.filter((id) => !completedStepIds.includes(id)),
                [],
                variables,
                stepResults,
                totalSteps,
              ) as any,
            },
          });
        }

        // Handle pause for approval
        if (ev.type === "workflow_approval_required") {
          await prisma.workflowRun.update({
            where: { id: runId },
            data: { status: "paused", currentStepId: ev.stepId },
          });
          yield event;

          // Exit generator — caller must call resumeApproval to continue
          return;
        }

        // Handle completion
        if (ev.type === "workflow_completed") {
          const durationMs = Date.now() - startTime;

          await prisma.workflowRun.update({
            where: { id: runId },
            data: {
              status: "completed",
              output: context.stepResults as any,
              durationMs,
              completedAt: new Date(),
              progress: {
                completed: completedStepIds.filter((id) => stepStatuses.get(id) === "completed").length,
                total: totalSteps,
                failed: completedStepIds.filter((id) => stepStatuses.get(id) === "failed").length,
                skipped: completedStepIds.filter((id) => stepStatuses.get(id) === "skipped").length,
                running: 0,
              } as any,
            },
          });

          await prisma.workflow.update({
            where: { id: workflowId },
            data: { runCount: { increment: 1 }, lastRunAt: new Date() },
          });

          yield {
            ...(event as Record<string, unknown>),
            totalDurationMs: durationMs,
          };
          return;
        }

        // Handle failure
        if (ev.type === "workflow_failed") {
          await prisma.workflowRun.update({
            where: { id: runId },
            data: {
              status: "failed",
              error: ev.error || "Workflow failed",
              completedAt: new Date(),
              durationMs: Date.now() - startTime,
            },
          });

          yield event;
          return;
        }

        yield event;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";

      await prisma.workflowRun.update({
        where: { id: runId },
        data: {
          status: "failed",
          error: errorMsg,
          completedAt: new Date(),
          durationMs: Date.now() - startTime,
        },
      });

      yield { type: "workflow_failed", runId, error: errorMsg };
    }
  }

  /** Handle an approval decision for a paused workflow */
  async *handleApproval(
    runId: string,
    action: "approve" | "reject",
    modifiedArgs?: Record<string, unknown>,
    rejectionReason?: string,
  ): AsyncGenerator<unknown> {
    // Find the pending approval
    const pendingKeys = [...this.pendingApprovals.keys()].filter((k) =>
      k.startsWith(`${runId}:`),
    );

    for (const key of pendingKeys) {
      const pending = this.pendingApprovals.get(key);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingApprovals.delete(key);

        if (action === "approve") {
          pending.resolve({ action: "approved", modifiedArgs });
        } else {
          pending.resolve({ action: "rejected", modifiedArgs });
        }

        yield {
          type: "workflow_approval_result",
          runId,
          stepId: pending.stepId,
          status: action === "approve" ? "approved" : "rejected",
          rejectionReason,
        };
      }
    }

    // Resume the workflow
    const run = await prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run) {
      yield { type: "workflow_failed", runId, error: "Run not found" };
      return;
    }

    // Check if the run is paused
    if (run.status !== "paused") {
      yield {
        type: "workflow_failed",
        runId,
        error: `Run is ${run.status}, not paused`,
      };
      return;
    }

    // The run will be resumed by the caller re-invoking runWorkflow
    // with the checkpoint data, or we need to continue the generator
    yield {
      type: "workflow_resumed",
      runId,
      resumedFrom: run.currentStepId || "checkpoint",
    };
  }

  /** Pause a running workflow */
  async pauseRun(
    runId: string,
    userId: string,
  ): Promise<WorkflowRunDTO | null> {
    const run = await findRunById(runId, userId);
    if (!run || run.status !== "running") return null;

    const updated = await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "paused" },
    });

    return runToDTO(updated);
  }

  /** Resume a paused workflow from checkpoint */
  async *resumeRun(runId: string, userId: string): AsyncGenerator<unknown> {
    const run = await findRunById(runId, userId);
    if (!run) {
      yield { type: "workflow_failed", runId, error: "Run not found" };
      return;
    }
    if (run.status !== "paused") {
      yield {
        type: "workflow_failed",
        runId,
        error: `Run is ${run.status}, not paused`,
      };
      return;
    }

    // Load workflow definition
    const workflow = await findWorkflowById(run.workflowId, userId);
    if (!workflow) {
      yield { type: "workflow_failed", runId, error: "Workflow not found" };
      return;
    }

    const definition = workflow.definition as unknown as WorkflowDefinition;
    const checkpoint = (run.checkpoint || {}) as Record<string, unknown>;
    const completedStepIds: string[] =
      (checkpoint.completedSteps as string[]) || [];
    const stepStatuses = new Map<string, "completed" | "failed" | "skipped">();
    const savedVariables =
      (checkpoint.variables as Record<string, unknown>) || {};
    const savedStepResults =
      (checkpoint.stepResults as Record<string, unknown>) || {};

    // Rebuild context from checkpoint
    const variables = { ...savedVariables };
    const stepResults = { ...savedStepResults };
    const allStepIds = definition.steps.map((s) => s.id);
    const totalSteps = allStepIds.length;

    // Update status to running
    await prisma.workflowRun.update({
      where: { id: runId },
      data: { status: "running" },
    });

    yield { type: "workflow_resumed", runId, resumedFrom: run.currentStepId };

    // Re-create execution context
    const pendingApprovals = this.pendingApprovals;
    const context: DAGExecutionContext = {
      runId,
      conversationId: "",
      variables,
      stepResults,
      userId,
      definition,
      emit: () => {},
      pauseForApproval: (stepId, message, details, timeoutMs) => {
        return new Promise((resolve) => {
          const key = `${runId}:${stepId}`;
          const timeout = setTimeout(() => {
            const pending = pendingApprovals.get(key);
            if (pending) {
              pendingApprovals.delete(key);
              pending.resolve({ action: "timed_out" as const });
            }
          }, timeoutMs);
          pendingApprovals.set(key, { resolve, timeout, stepId });
        });
      },
    };

    // Re-execute DAG — skip completed steps
    for (const stepId of completedStepIds) {
      // NOTE: Current checkpoint format does not store per-step status
      // (completed/failed/skipped). All checkpointed steps default to "completed".
      stepStatuses.set(stepId, "completed");
      if (!(stepId in stepResults)) {
        stepResults[stepId] = { status: "completed", result: "(resumed)" };
      }
    }

    for await (const ev of this.dagExecutor.executeWithSkip(
      context,
      new Set(completedStepIds),
    )) {
      const event = ev as Record<string, unknown>;

      // Update progress
      if (
        event.type !== "workflow_approval_required" &&
        event.type !== "workflow_completed"
      ) {
        const stepId = event.stepId as string;
        if (stepId && !completedStepIds.includes(stepId)) {
          completedStepIds.push(stepId);
          const status: "completed" | "failed" | "skipped" =
            event.type === "workflow_step_failed"
              ? "failed"
              : (event as any).status === "skipped"
                ? "skipped"
                : "completed";
          stepStatuses.set(stepId, status);
          const progress: ProgressSummary = {
            completed: completedStepIds.filter((id) => stepStatuses.get(id) === "completed").length,
            total: totalSteps,
            failed: completedStepIds.filter((id) => stepStatuses.get(id) === "failed").length,
            skipped: completedStepIds.filter((id) => stepStatuses.get(id) === "skipped").length,
            running: 0,
          };
          await prisma.workflowRun.update({
            where: { id: runId },
            data: {
              progress: progress as any,
              currentStepId: stepId,
              checkpoint: this.dagExecutor.buildCheckpoint(
                runId,
                run.workflowId,
                completedStepIds,
                allStepIds.filter((id) => !completedStepIds.includes(id)),
                [],
                variables,
                stepResults,
                totalSteps,
              ) as any,
            },
          });
        }
      }

      // Handle approval
      if (event.type === "workflow_approval_required") {
        await prisma.workflowRun.update({
          where: { id: runId },
          data: { status: "paused", currentStepId: event.stepId as string },
        });
        yield event;
        return;
      }

      // Handle completion
      if (event.type === "workflow_completed") {
        await prisma.workflowRun.update({
          where: { id: runId },
          data: {
            status: "completed",
            output: stepResults as any,
            completedAt: new Date(),
            progress: {
              completed: completedStepIds.filter((id) => stepStatuses.get(id) === "completed").length,
              total: totalSteps,
              failed: completedStepIds.filter((id) => stepStatuses.get(id) === "failed").length,
              skipped: completedStepIds.filter((id) => stepStatuses.get(id) === "skipped").length,
              running: 0,
            } as any,
          },
        });
        yield event;
        return;
      }

      // Handle failure
      if (event.type === "workflow_failed") {
        await prisma.workflowRun.update({
          where: { id: runId },
          data: {
            status: "failed",
            error: (event.error as string) || "Workflow failed",
            completedAt: new Date(),
          },
        });
        yield event;
        return;
      }

      yield event;
    }
  }

  /** Cancel a running or paused workflow */
  async cancelRun(
    runId: string,
    userId: string,
  ): Promise<WorkflowRunDTO | null> {
    const run = await findRunById(runId, userId);
    if (!run || (run.status !== "running" && run.status !== "paused"))
      return null;

    const updated = await prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: "cancelled",
        completedAt: new Date(),
      },
    });

    // Clean up pending approvals
    for (const [key, pending] of this.pendingApprovals) {
      if (key.startsWith(`${runId}:`)) {
        clearTimeout(pending.timeout);
        this.pendingApprovals.delete(key);
      }
    }

    return runToDTO(updated);
  }

  // ========== Runs ==========

  /** List runs for a workflow */
  async listRuns(
    workflowId: string,
    userId: string,
    options: { status?: string; page?: number; limit?: number } = {},
  ): Promise<{ items: WorkflowRunDTO[]; total: number; page: number }> {
    const page = options.page || 1;
    const limit = options.limit || 20;
    const where: Prisma.WorkflowRunWhereInput = { workflowId, userId };

    if (options.status) {
      where.status = options.status;
    }

    const [runs, total] = await listRunsForWorkflow(where, page, limit);

    return {
      items: runs.map((r) => runToDTO(r)),
      total,
      page,
    };
  }

  /** Get a single run with step logs */
  async getRun(
    runId: string,
    userId: string,
  ): Promise<{ run: WorkflowRunDTO; stepLogs: WorkflowStepLogDTO[] } | null> {
    const result = await findRunWithLogs(runId, userId);
    if (!result) return null;

    return {
      run: runToDTO(result.run),
      stepLogs: result.stepLogs.map((sl) => stepLogToDTO(sl)),
    };
  }

  /** Save a step log */
  async saveStepLog(
    runId: string,
    stepId: string,
    stepType: string,
    result: StepResult,
  ): Promise<void> {
    try {
      await prisma.workflowStepLog.create({
        data: {
          id: randomUUID(),
          runId,
          stepId,
          stepType,
          status: result.status,
          output:
            result.output !== undefined ? (result.output as object) : undefined,
          error: result.error || null,
          retryCount: result.retryCount || 0,
          durationMs: result.durationMs || 0,
          tokensUsed: result.tokensUsed || 0,
        },
      });
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : "Unknown error" }, "Failed to save step log");
    }
  }

}

// Singleton
export const workflowService = new WorkflowService();
