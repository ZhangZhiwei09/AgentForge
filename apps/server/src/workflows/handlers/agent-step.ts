// Agent Step Handler — executes an AgentService ReAct loop as a workflow step
import type {
  WorkflowAgentStep,
  StepResult,
  WorkflowStep,
} from "@agentforge/shared-types";
import { AgentService } from "../../services/agent.js";
import { variableResolver } from "../variable-resolver.js";
import type { StepHandler, StepContext } from "./types.js";

const agentService = new AgentService();

export class AgentStepHandler implements StepHandler {
  async execute(step: WorkflowStep, context: StepContext): Promise<StepResult> {
    const agentStep = step as WorkflowAgentStep;
    const startTime = Date.now();
    const resolvedPrompt = variableResolver.resolve(agentStep.prompt, {
      runId: context.runId,
      variables: context.variables,
      stepResults: context.stepResults,
    });

    const resolvedSystemPrompt = agentStep.system_prompt
      ? variableResolver.resolve(agentStep.system_prompt, {
          runId: context.runId,
          variables: context.variables,
          stepResults: context.stepResults,
        })
      : undefined;

    const events: unknown[] = [];
    let tokensUsed = 0;

    try {
      for await (const event of agentService.run(
        context.conversationId,
        resolvedPrompt,
        {
          model: agentStep.model ?? null,
          maxIterations: agentStep.max_iterations ?? 10,
          tools: agentStep.tools ?? null,
        },
      )) {
        events.push(event);

        // Forward agent events as workflow step progress
        context.emit({
          type: "workflow_step_progress",
          stepId: agentStep.id,
          agentEvent: event,
        });

        // Handle approval pauses
        const agentEvent = event as unknown as Record<string, unknown>;
        if (agentEvent.type === "agent_approval_required") {
          const decision = await context.pauseForApproval(
            agentStep.id,
            `Approve tool: ${agentEvent.tool_name}?`,
            { toolName: agentEvent.tool_name, toolArgs: agentEvent.tool_args },
            (agentEvent.timeout_ms as number) || 300000,
          );

          if (decision.action !== "approved") {
            return {
              status: "skipped",
              output: null,
              durationMs: Date.now() - startTime,
              tokensUsed,
              reason: `approval_${decision.action}`,
            };
          }
        }

        // Track completion
        if (agentEvent.type === "agent_done") {
          return {
            status: "completed",
            output: agentEvent.summary || agentEvent.result,
            durationMs: Date.now() - startTime,
            tokensUsed,
          };
        }

        // Handle errors
        if (agentEvent.type === "agent_error") {
          return {
            status: "failed",
            output: null,
            error: agentEvent.error as string,
            durationMs: Date.now() - startTime,
            tokensUsed,
          };
        }

        // Rough token usage estimate
        if (
          agentEvent.type === "agent_respond" ||
          agentEvent.type === "agent_token"
        ) {
          tokensUsed += 50;
        }
      }

      // If loop finished without agent_done, take the last event's output
      const lastEvent = events[events.length - 1] as
        | Record<string, unknown>
        | undefined;
      return {
        status: "completed",
        output: lastEvent?.result || null,
        durationMs: Date.now() - startTime,
        tokensUsed,
      };
    } catch (err) {
      return {
        status: "failed",
        output: null,
        error: err instanceof Error ? err.message : "Agent step failed",
        durationMs: Date.now() - startTime,
        tokensUsed,
      };
    }
  }
}
