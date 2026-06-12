// Human Approval Step Handler — pauses the workflow and waits for user approval
import type {
  WorkflowHumanApprovalStep,
  StepResult,
  WorkflowStep,
} from "@agentforge/shared-types";
import { variableResolver } from "../variable-resolver.js";
import type { StepHandler, StepContext } from "./types.js";

export class HumanApprovalStepHandler implements StepHandler {
  async execute(step: WorkflowStep, context: StepContext): Promise<StepResult> {
    const approvalStep = step as WorkflowHumanApprovalStep;
    const startTime = Date.now();

    const resolvedMessage = variableResolver.resolve(approvalStep.message, {
      runId: context.runId,
      variables: context.variables,
      stepResults: context.stepResults,
    });

    const resolvedDetails = approvalStep.details
      ? (variableResolver.resolveObject(approvalStep.details, {
          runId: context.runId,
          variables: context.variables,
          stepResults: context.stepResults,
        }) as Record<string, unknown>)
      : undefined;

    // Emit approval required event
    context.emit({
      type: "workflow_approval_required",
      runId: context.runId,
      stepId: approvalStep.id,
      message: resolvedMessage,
      details: resolvedDetails,
      timeoutSeconds: approvalStep.timeout_seconds || 300,
    });

    const decision = await context.pauseForApproval(
      approvalStep.id,
      resolvedMessage,
      resolvedDetails,
      (approvalStep.timeout_seconds || 300) * 1000,
    );

    if (decision.action === "rejected" || decision.action === "timed_out") {
      if (approvalStep.on_reject === "fail") {
        return {
          status: "failed",
          output: null,
          durationMs: Date.now() - startTime,
          reason:
            decision.action === "timed_out"
              ? "approval_timeout"
              : "approval_rejected",
        };
      }
      return {
        status: "skipped",
        output: null,
        durationMs: Date.now() - startTime,
        reason:
          decision.action === "timed_out"
            ? "approval_timeout"
            : "approval_rejected",
      };
    }

    return {
      status: "completed",
      output: decision.modifiedArgs || { approved: true },
      durationMs: Date.now() - startTime,
    };
  }
}
