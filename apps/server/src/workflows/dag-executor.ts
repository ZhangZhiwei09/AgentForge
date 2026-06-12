// DAG Executor — topology sort + level-based parallel execution + checkpoint + retry
// Core engine for running workflow definitions step by step
import type { WorkflowStep, StepResult, WorkflowDefinition, ProgressSummary } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import {
  AgentStepHandler,
  ToolStepHandler,
  ConditionStepHandler,
  ParallelStepHandler,
  HumanApprovalStepHandler,
  TransformStepHandler,
} from "./handlers/index.js";
import type { StepHandler, StepContext } from "./handlers/index.js";
import type { VariableContext } from "./variable-resolver.js";

// ---- Types ----

export interface DAGExecutionContext extends StepContext {
  definition: WorkflowDefinition;
  emit: (event: unknown) => void;
  pauseForApproval: (stepId: string, message: string, details: Record<string, unknown> | undefined, timeoutMs: number) => Promise<{
    action: "approved" | "rejected" | "timed_out";
    modifiedArgs?: Record<string, unknown>;
  }>;
}

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

interface LevelPlan {
  level: number;
  steps: WorkflowStep[];
}

// ---- DAG Executor ----

export class DAGExecutor {
  private handlers: Record<string, StepHandler>;

  constructor() {
    // Initialize handlers
    const parallelHandler = new ParallelStepHandler(
      (step: WorkflowStep, ctx: StepContext) => this.executeSingleStep(step, ctx),
    );

    this.handlers = {
      agent: new AgentStepHandler(),
      tool: new ToolStepHandler(),
      condition: new ConditionStepHandler(),
      parallel: parallelHandler,
      human_approval: new HumanApprovalStepHandler(),
      transform: new TransformStepHandler(),
    };
  }

  /**
   * Execute a workflow definition from start to finish.
   * Yields events for each step's lifecycle.
   */
  async *execute(context: DAGExecutionContext): AsyncGenerator<unknown> {
    const definition = context.definition;
    const steps = definition.steps;

    // 1. Topological sort into execution levels
    const levels = this.topologicalSort(steps);

    const totalSteps = steps.length;
    let completedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    yield {
      type: "workflow_started",
      runId: context.runId,
      workflowName: definition.name,
      totalSteps,
    };

    const allStepLogs: StepResult[] = [];

    // 2. Execute level by level
    for (const level of levels) {
      // Emit started events for all steps in this level
      for (const step of level.steps) {
        yield {
          type: "workflow_step_started",
          stepId: step.id,
          stepType: step.type,
        };
      }

      // Execute all steps in this level concurrently
      const levelResults = await Promise.allSettled(
        level.steps.map(async (step) => {
          const startTime = Date.now();

          try {
            const result = await this.executeWithRetry(step, context, definition);
            const durationMs = Date.now() - startTime;

            return {
              stepId: step.id,
              stepType: step.type,
              result: { ...result, durationMs: result.durationMs || durationMs },
            };
          } catch (err) {
            return {
              stepId: step.id,
              stepType: step.type,
              result: {
                status: "failed" as const,
                output: null,
                error: err instanceof Error ? err.message : "Step execution failed",
                durationMs: Date.now() - startTime,
              },
            };
          }
        }),
      );

      // 3. Process results for this level
      for (const [i, settled] of levelResults.entries()) {
        const step = level.steps[i];

        if (settled.status === "fulfilled") {
          const { result } = settled.value;
          allStepLogs.push(result);

          // Store step output in context
          if (result.status === "completed") {
            context.stepResults[step.id] = result.output;
            completedCount++;
          } else if (result.status === "skipped") {
            skippedCount++;
          } else {
            failedCount++;
          }

          // Emit event
          if (result.status === "completed") {
            yield {
              type: "workflow_step_completed",
              stepId: step.id,
              status: "completed",
              output: result.output,
              durationMs: result.durationMs,
            };
          } else if (result.status === "skipped") {
            yield {
              type: "workflow_step_completed",
              stepId: step.id,
              status: "skipped",
              output: result.output,
              durationMs: result.durationMs,
            };
          } else {
            yield {
              type: "workflow_step_failed",
              stepId: step.id,
              error: result.error || "Unknown error",
              retryCount: result.retryCount || 0,
            };
          }

          // Update context for condition steps that produce sub-steps
          if (
            step.type === "condition" &&
            result.status === "completed" &&
            result.output &&
            typeof result.output === "object" &&
            (result.output as Record<string, unknown>).subSteps
          ) {
            const conditionOutput = result.output as { branch: string; subSteps: WorkflowStep[] };
            // Store branch info
            context.stepResults[`${step.id}_branch`] = conditionOutput.branch;
          }
        } else {
          // Promise rejected
          failedCount++;
          allStepLogs.push({
            status: "failed",
            output: null,
            error: settled.reason?.message || "Step promise rejected",
          });

          yield {
            type: "workflow_step_failed",
            stepId: step.id,
            error: settled.reason?.message || "Step promise rejected",
          };

          if (definition.on_failure === "stop") {
            yield {
              type: "workflow_failed",
              runId: context.runId,
              error: `Step ${step.id} failed`,
              failedStepId: step.id,
            };
            return;
          }
        }
      }
    }

    // 4. Workflow complete
    const progress = {
      completed: completedCount,
      total: totalSteps,
      failed: failedCount,
      skipped: skippedCount,
      running: 0,
    };

    yield {
      type: "workflow_completed",
      runId: context.runId,
      output: context.stepResults,
      totalDurationMs: 0, // Will be set by caller
      stepSummary: progress,
    };
  }

  /**
   * Like execute(), but skips steps whose IDs are in the skipIds set.
   * Used by resumeRun to continue from a checkpoint without re-running completed steps.
   */
  async *executeWithSkip(
    context: DAGExecutionContext,
    skipIds: Set<string>,
  ): AsyncGenerator<unknown> {
    const definition = context.definition;
    const steps = definition.steps;
    const levels = this.topologicalSort(steps);
    const totalSteps = steps.length;
    let completedCount = skipIds.size;
    let failedCount = 0;
    let skippedCount = 0;

    yield {
      type: "workflow_started",
      runId: context.runId,
      workflowName: definition.name,
      totalSteps,
      resumedFromCheckpoint: skipIds.size > 0,
    };

    // Execute level by level, skipping completed steps
    for (const level of levels) {
      // Filter out skipped steps; yield skip-completed events for them
      const pendingSteps = level.steps.filter((s) => {
        if (skipIds.has(s.id)) {
          // Don't re-emit events for skipped steps on resume — they were already emitted
          return false;
        }
        return true;
      });

      // Emit started events for all steps in this level
      for (const step of level.steps) {
        yield {
          type: "workflow_step_started",
          stepId: step.id,
          stepType: step.type,
        };
        if (skipIds.has(step.id)) {
          yield {
            type: "workflow_step_completed",
            stepId: step.id,
            stepType: step.type,
            status: "completed",
            output: context.stepResults[step.id] || "(resumed from checkpoint)",
            durationMs: 0,
          };
        }
      }

      if (pendingSteps.length === 0) continue;

      // Execute pending steps in parallel (same as execute)
      const levelResults = await Promise.allSettled(
        pendingSteps.map(async (step) => {
          const startTime = Date.now();
          try {
            const result = await this.executeWithRetry(step, context, definition);
            const durationMs = Date.now() - startTime;
            return { stepId: step.id, stepType: step.type, result: { ...result, durationMs: result.durationMs || durationMs } };
          } catch (err) {
            return {
              stepId: step.id, stepType: step.type,
              result: {
                status: "failed" as const, output: null,
                error: err instanceof Error ? err.message : "Step execution failed",
                durationMs: Date.now() - startTime,
              },
            };
          }
        }),
      );

      for (const [i, settled] of levelResults.entries()) {
        const step = pendingSteps[i];
        if (settled.status === "fulfilled") {
          const { result } = settled.value;
          if (result.status === "completed") {
            context.stepResults[step.id] = result.output;
            completedCount++;
          } else if (result.status === "skipped") {
            skippedCount++;
          } else if ((result as any).status === "paused") {
            // Approval required — pause and return
            yield {
              type: "workflow_approval_required",
              stepId: step.id,
              stepType: step.type,
              title: (step as any).title || step.id,
              message: (result as any).message || "Approval required",
              details: (result as any).details,
            };
            return;
          } else {
            failedCount++;
          }

          if (result.status === "completed") {
            yield { type: "workflow_step_completed", stepId: step.id, status: "completed", output: result.output, durationMs: result.durationMs };
          } else if (result.status === "skipped") {
            yield { type: "workflow_step_completed", stepId: step.id, status: "skipped", output: result.output, durationMs: result.durationMs };
          } else {
            yield { type: "workflow_step_failed", stepId: step.id, error: result.error || "Unknown error", retryCount: result.retryCount || 0 };
          }
        } else {
          failedCount++;
          yield { type: "workflow_step_failed", stepId: step.id, error: settled.reason?.message || "Execution rejected" };
        }
      }
    }

    const progress: ProgressSummary = { completed: completedCount, total: totalSteps, failed: failedCount, skipped: skippedCount, running: 0 };
    yield {
      type: "workflow_completed",
      runId: context.runId,
      output: context.stepResults,
      totalDurationMs: 0,
      stepSummary: progress,
    };
  }

  /**
   * Topological sort — groups steps into levels that can execute concurrently.
   * Detects circular dependencies.
   */
  topologicalSort(steps: WorkflowStep[]): LevelPlan[] {
    const levels: LevelPlan[] = [];
    const completed = new Set<string>();
    const remaining = new Map(steps.map((s) => [s.id, s]));

    let levelIndex = 0;

    while (remaining.size > 0) {
      const currentLevel: WorkflowStep[] = [];
      let progress = false;

      for (const [id, step] of remaining) {
        const deps = step.depends_on || [];
        if (deps.every((d) => completed.has(d))) {
          currentLevel.push(step);
          remaining.delete(id);
          progress = true;
        }
      }

      if (!progress) {
        // Circular dependency or missing dependency reference
        const unresolved = [...remaining.keys()].join(", ");
        throw new Error(
          `Circular or unresolved dependency detected in steps: ${unresolved}. ` +
          `Completed: ${[...completed].join(", ")}`,
        );
      }

      levels.push({ level: levelIndex, steps: currentLevel });
      levelIndex++;

      for (const step of currentLevel) {
        completed.add(step.id);
      }
    }

    return levels;
  }

  /**
   * Execute a single step with retry logic.
   */
  private async executeWithRetry(
    step: WorkflowStep,
    context: StepContext,
    definition?: WorkflowDefinition,
  ): Promise<StepResult> {
    const retry = step.retry || { maxAttempts: 1, backoff: "fixed" as const, initialDelay: 0, maxDelay: 0, retryOn: [] };
    const maxAttempts = retry.maxAttempts || 1;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.executeSingleStepWithTimeout(step, context);
        return { ...result, retryCount: attempt };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Check if we should retry
        if (attempt < maxAttempts - 1) {
          const delay = this.calculateRetryDelay(retry, attempt + 1);
          logger.warn(
            { stepId: step.id, attempt: attempt + 1, maxAttempts, delayMs: delay },
            "Retrying failed step",
          );
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted — check timeout handling
    if (lastError?.message?.includes("timed out")) {
      const onTimeout = step.on_timeout || "fail";
      if (onTimeout === "skip") {
        return {
          status: "skipped",
          output: null,
          reason: `timeout after ${step.timeout || 60}s`,
          retryCount: maxAttempts,
        };
      }
      if (onTimeout === "fallback" && step.fallback_step && definition) {
        const fallbackStep = definition.steps.find(
          (s: WorkflowStep) => s.id === step.fallback_step,
        );
        if (fallbackStep) {
          logger.info({ stepId: step.id, fallbackStepId: fallbackStep.id }, "Executing fallback step");
          try {
            const fbResult = await this.executeWithRetry(fallbackStep, context, definition);
            return { ...fbResult, retryCount: maxAttempts };
          } catch {
            return {
              status: "failed",
              output: null,
              error: `Fallback step "${fallbackStep.id}" also failed`,
              retryCount: maxAttempts,
            };
          }
        }
      }
    }

    return {
      status: "failed",
      output: null,
      error: lastError?.message || "Step execution failed after retries",
      retryCount: maxAttempts,
    };
  }

  /**
   * Execute a single step with timeout enforcement.
   */
  private async executeSingleStepWithTimeout(
    step: WorkflowStep,
    context: StepContext,
  ): Promise<StepResult> {
    const timeoutMs = (step.timeout || 60) * 1000;

    return new Promise<StepResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Step ${step.id} timed out after ${step.timeout || 60}s`));
      }, timeoutMs);

      this.executeSingleStep(step, context)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Execute a single workflow step (no retry, no timeout — those are handled by executeWithRetry).
   */
  async executeSingleStep(step: WorkflowStep, context: StepContext): Promise<StepResult> {
    const handler = this.handlers[step.type];
    if (!handler) {
      return {
        status: "failed",
        output: null,
        error: `Unknown step type: ${step.type}`,
      };
    }

    try {
      return await handler.execute(step, context);
    } catch (err) {
      return {
        status: "failed",
        output: null,
        error: err instanceof Error ? err.message : "Step handler error",
      };
    }
  }

  /**
   * Build a checkpoint from the current execution state.
   */
  buildCheckpoint(
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

  // ---- Helpers ----

  private calculateRetryDelay(
    retry: { backoff: string; initialDelay: number; maxDelay: number },
    attempt: number,
  ): number {
    switch (retry.backoff) {
      case "fixed":
        return retry.initialDelay;
      case "linear":
        return Math.min(retry.initialDelay * attempt, retry.maxDelay);
      case "exponential":
        return Math.min(retry.initialDelay * Math.pow(2, attempt - 1), retry.maxDelay);
      default:
        return retry.initialDelay;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
