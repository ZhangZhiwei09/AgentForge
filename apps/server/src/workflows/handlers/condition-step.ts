// Condition Step Handler — evaluates a condition expression and routes to branches
import type {
  WorkflowConditionStep,
  WorkflowStep,
  StepResult,
} from "@agentforge/shared-types";
import { SafeEvaluator } from "../variable-resolver.js";
import type { StepHandler, StepContext } from "./types.js";

export class ConditionStepHandler implements StepHandler {
  async execute(step: WorkflowStep, context: StepContext): Promise<StepResult> {
    const condStep = step as WorkflowConditionStep;
    const vctx = {
      runId: context.runId,
      variables: context.variables,
      stepResults: context.stepResults,
    };

    // Evaluate the condition expression
    const result = SafeEvaluator.evaluate(condStep.expression, vctx);
    const branchKey = result ? "true" : "false";

    // Find matching branch (fallback to default or first available)
    const branchSteps: WorkflowStep[] =
      condStep.branches[branchKey] ||
      (condStep.default_branch
        ? condStep.branches[condStep.default_branch]
        : null) ||
      [];

    return {
      status: "completed",
      output: {
        branch: branchKey,
        expression: condStep.expression,
        evaluatedTo: result,
        subSteps: branchSteps,
      },
    };
  }
}
