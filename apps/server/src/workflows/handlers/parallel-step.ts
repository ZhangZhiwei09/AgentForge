// Parallel Step Handler — executes multiple branches concurrently
import type { WorkflowParallelStep, WorkflowStep, StepResult } from "@agentforge/shared-types";
import type { StepHandler, StepContext } from "./types.js";
import { logger } from "@agentforge/logger";

type StepExecutor = (step: WorkflowStep, ctx: StepContext) => Promise<StepResult>;

export class ParallelStepHandler implements StepHandler {
  private executeStep: StepExecutor;

  constructor(executeStep: StepExecutor) {
    this.executeStep = executeStep;
  }

  async execute(step: WorkflowStep, context: StepContext): Promise<StepResult> {
    const parStep = step as WorkflowParallelStep;
    const startTime = Date.now();
    const branchResults: Array<{ branchId: string; label?: string; results: StepResult[]; error?: string }> = [];

    const branchPromises = parStep.branches.map(async (branch: { id: string; label?: string; steps: WorkflowStep[] }) => {
      const results: StepResult[] = [];

      try {
        for (const subStep of branch.steps) {
          const result = await this.executeStep(subStep, context);
          results.push(result);

          if (result.status === "failed") {
            logger.warn({ branchId: branch.id, stepId: subStep.id }, "Branch step failed");
            if (parStep.wait === "all") {
              return {
                branchId: branch.id,
                label: branch.label,
                results,
                error: `Step ${subStep.id} failed: ${result.error}`,
              };
            }
          }
        }

        return {
          branchId: branch.id,
          label: branch.label,
          results,
        };
      } catch (err) {
        return {
          branchId: branch.id,
          label: branch.label,
          results,
          error: err instanceof Error ? err.message : "Branch execution failed",
        };
      }
    });

    const settled = await Promise.allSettled(branchPromises);

    for (const result of settled) {
      if (result.status === "fulfilled") {
        branchResults.push(result.value);
      } else {
        branchResults.push({
          branchId: "unknown",
          results: [],
          error: result.reason?.message || "Branch promise rejected",
        });
      }
    }

    const failures = branchResults.filter((b) => b.error);

    if (parStep.wait === "all" && failures.length > 0) {
      return {
        status: "failed",
        output: branchResults,
        error: `${failures.length}/${parStep.branches.length} branches failed`,
        durationMs: Date.now() - startTime,
      };
    }

    const branchOutputs = branchResults.map((b) => ({
      branchId: b.branchId,
      label: b.label,
      output: b.results.length > 0 ? b.results[b.results.length - 1].output : null,
      error: b.error,
    }));

    return {
      status: "completed",
      output: branchOutputs,
      durationMs: Date.now() - startTime,
    };
  }
}
