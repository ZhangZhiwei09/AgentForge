// Transform Step Handler — transforms data between workflow steps
import type { WorkflowTransformStep, StepResult, WorkflowStep } from "@agentforge/shared-types";
import { SafeEvaluator, variableResolver } from "../variable-resolver.js";
import type { StepHandler, StepContext } from "./types.js";

export class TransformStepHandler implements StepHandler {
  async execute(step: WorkflowStep, context: StepContext): Promise<StepResult> {
    const xfStep = step as WorkflowTransformStep;
    const startTime = Date.now();
    const vctx = {
      runId: context.runId,
      variables: context.variables,
      stepResults: context.stepResults,
    };

    try {
      switch (xfStep.operation) {
        case "merge": {
          const resolved = variableResolver.resolve(xfStep.expression, vctx);
          let output: unknown;
          try {
            output = JSON.parse(resolved);
          } catch {
            output = resolved;
          }
          return { status: "completed", output, durationMs: Date.now() - startTime };
        }

        case "jsonata": {
          const resolved = SafeEvaluator.evaluateTemplate(xfStep.expression, vctx);
          return { status: "completed", output: resolved, durationMs: Date.now() - startTime };
        }

        case "map": {
          const inputKey = xfStep.input || Object.keys(context.stepResults).pop() || "";
          const inputData = context.stepResults[inputKey];
          if (!Array.isArray(inputData)) {
            return {
              status: "failed",
              output: null,
              error: `Transform map: input "${inputKey}" is not an array`,
              durationMs: Date.now() - startTime,
            };
          }
          const results = (inputData as unknown[]).map((item, index) => {
            const itemCtx = {
              ...vctx,
              variables: { ...vctx.variables, _item: item, _index: index },
            };
            return SafeEvaluator.evaluateTemplate(xfStep.expression, itemCtx);
          });
          return { status: "completed", output: results, durationMs: Date.now() - startTime };
        }

        case "filter": {
          const inputKey = xfStep.input || Object.keys(context.stepResults).pop() || "";
          const inputData = context.stepResults[inputKey];
          if (!Array.isArray(inputData)) {
            return {
              status: "failed",
              output: null,
              error: `Transform filter: input "${inputKey}" is not an array`,
              durationMs: Date.now() - startTime,
            };
          }
          const results = (inputData as unknown[]).filter((item, index) => {
            const itemCtx = {
              ...vctx,
              variables: { ...vctx.variables, _item: item, _index: index },
            };
            return SafeEvaluator.evaluate(xfStep.expression, itemCtx);
          });
          return { status: "completed", output: results, durationMs: Date.now() - startTime };
        }

        default:
          return {
            status: "failed",
            output: null,
            error: `Unknown transform operation: ${(xfStep as any).operation}`,
            durationMs: Date.now() - startTime,
          };
      }
    } catch (err) {
      return {
        status: "failed",
        output: null,
        error: err instanceof Error ? err.message : "Transform step failed",
        durationMs: Date.now() - startTime,
      };
    }
  }
}
