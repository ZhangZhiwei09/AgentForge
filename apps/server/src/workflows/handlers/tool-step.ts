// Tool Step Handler — executes a ToolRegistry tool as a workflow step
import type { WorkflowToolStep, StepResult, WorkflowStep } from "@agentforge/shared-types";
import { toolRegistry } from "../../tools/registry.js";
import { variableResolver } from "../variable-resolver.js";
import type { StepHandler, StepContext } from "./types.js";

export class ToolStepHandler implements StepHandler {
  async execute(step: WorkflowStep, context: StepContext): Promise<StepResult> {
    const toolStep = step as WorkflowToolStep;
    const startTime = Date.now();

    // Resolve template variables in args
    const resolvedArgs = variableResolver.resolveObject(toolStep.args || {}, {
      runId: context.runId,
      variables: context.variables,
      stepResults: context.stepResults,
    }) as Record<string, unknown>;

    // Check if approval is required
    if (toolStep.require_approval) {
      const decision = await context.pauseForApproval(
        toolStep.id,
        `Approve tool execution: ${toolStep.tool}?`,
        { tool: toolStep.tool, args: resolvedArgs },
        300000,
      );

      if (decision.action !== "approved") {
        return {
          status: "skipped",
          output: null,
          durationMs: Date.now() - startTime,
          reason: `approval_${decision.action}`,
        };
      }

      if (decision.modifiedArgs) {
        Object.assign(resolvedArgs, decision.modifiedArgs);
      }
    }

    // Execute the tool
    try {
      const result = await toolRegistry.execute(toolStep.tool, resolvedArgs);
      return {
        status: "completed",
        output: result,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        status: "failed",
        output: null,
        error: err instanceof Error ? err.message : "Tool execution failed",
        durationMs: Date.now() - startTime,
      };
    }
  }
}
