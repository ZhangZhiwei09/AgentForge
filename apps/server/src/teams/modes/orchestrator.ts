// Orchestrator Mode — hierarchical delegation pattern
// The Orchestrator agent controls the flow, delegating tasks to specialist agents one at a time
import type {
  TeamDefinition,
  TeamStreamEvent,
  AgentRole,
} from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import { AgentService } from "../../services/agent.js";
import type { CollaborationModeExecutor, ExecutionContext } from "./types.js";
import { buildAgentTask, getRoleByName, toTeamEvent } from "./types.js";

export class OrchestratorMode implements CollaborationModeExecutor {
  async *execute(
    definition: TeamDefinition,
    task: string,
    context: ExecutionContext,
  ): AsyncGenerator<TeamStreamEvent> {
    const bus = context.bus;
    const bb = context.blackboard;
    const maxRounds = definition.maxTotalIterations;

    // Find the orchestrator agent
    const orchName =
      definition.orchestrator ||
      definition.agents.find((a) => a.canDelegate)?.name;
    if (!orchName) {
      yield {
        type: "team_failed",
        error: "No orchestrator agent found with canDelegate=true",
      };
      return;
    }

    const orchRole = getRoleByName(definition, orchName)!;

    // Write task to blackboard
    bb.write("task", task, "system");

    yield {
      type: "team_started",
      teamRunId: context.teamRunId,
      teamName: definition.name,
      mode: "orchestrator",
      agents: definition.agents.map((a) => ({
        name: a.name,
        role: a.displayName,
      })),
    };

    for (let round = 0; round < maxRounds; round++) {
      yield {
        type: "team_round_start",
        roundNumber: round + 1,
        totalRounds: maxRounds,
      };

      // Run orchestrator agent
      const orchTask = buildAgentTask(orchRole, task, bb, bus);

      yield {
        type: "agent_started",
        agentName: orchName,
        role: orchRole.displayName,
        task: orchTask,
      };

      const agentService = new AgentService();
      let orchOutput: string | null = null;

      try {
        for await (const event of agentService.run(
          context.conversationId,
          orchTask,
          {
            maxIterations: orchRole.maxIterations,
            tools: orchRole.tools.length > 0 ? orchRole.tools : null,
            scope: context.scope,
          },
        )) {
          const teamEvent = toTeamEvent(event, orchName);
          if (teamEvent) yield teamEvent;
          if (event.type === "agent_respond") {
            orchOutput = event.content || event.summary || null;
          }
        }

        yield {
          type: "agent_completed",
          agentName: orchName,
          output: orchOutput || "Orchestrator completed planning",
          durationMs: 0,
        };
      } catch (err) {
        yield {
          type: "agent_error",
          agentName: orchName,
          error: err instanceof Error ? err.message : "Orchestrator failed",
        };

        if (definition.onFailure === "stop") {
          yield { type: "team_failed", error: `Orchestrator failed: ${err}` };
          return;
        }
        continue;
      }

      // Parse orchestrator output for delegation decisions
      const delegateTo = this.parseDelegation(orchOutput || "");

      if (!delegateTo) {
        // Orchestrator has no more delegations → done
        break;
      }

      // Execute the delegated agent
      yield* this.executeDelegate(
        delegateTo.agentName,
        delegateTo.subTask,
        definition,
        context,
        bus,
        bb,
      );
    }

    // Build final output from blackboard
    yield {
      type: "team_completed",
      output: bb.snapshot(),
      totalDurationMs: 0,
      roundsCount: maxRounds,
    };
  }

  /** Parse orchestrator output to find delegation command */
  private parseDelegation(
    output: string,
  ): { agentName: string; subTask: string } | null {
    try {
      // Try to find JSON in the output
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.action === "delegate" && parsed.to && parsed.task) {
          return { agentName: parsed.to, subTask: parsed.task };
        }
      }
    } catch (err: unknown) {
      // JSON parse failed, try text-based delegation parsing
      logger.warn(
        { rawOutput: output?.slice(0, 200) },
        "Orchestrator JSON parse failed, falling back to text-based parsing",
      );
    }

    // Text-based fallback: look for "delegate to X: task"
    const textMatch = output.match(
      /delegate\s+(?:to\s+)?(\w+)\s*[:：]\s*(.+)/i,
    );
    if (textMatch) {
      return { agentName: textMatch[1], subTask: textMatch[2] };
    }

    // Check if orchestrator indicated "done"
    if (/action.*done|任务完成|all done|no more/i.test(output)) {
      return null;
    }

    return null;
  }

  /** Execute a delegated agent */
  private async *executeDelegate(
    agentName: string,
    subTask: string,
    definition: TeamDefinition,
    context: ExecutionContext,
    bus: typeof context.bus,
    bb: typeof context.blackboard,
  ): AsyncGenerator<TeamStreamEvent> {
    const role = getRoleByName(definition, agentName);
    if (!role) {
      yield {
        type: "agent_error",
        agentName,
        error: `Agent "${agentName}" not found in team definition`,
      };
      return;
    }

    // Send task message via bus
    bus.send("orchestrator", agentName, "task", { task: subTask });

    const agentTask = buildAgentTask(role, subTask, bb, bus);
    yield {
      type: "agent_started",
      agentName,
      role: role.displayName,
      task: subTask,
    };

    const agentService = new AgentService();

    try {
      for await (const event of agentService.run(
        context.conversationId,
        agentTask,
        {
          maxIterations: role.maxIterations,
          tools: role.tools.length > 0 ? role.tools : null,
          scope: context.scope,
        },
      )) {
        const teamEvent = toTeamEvent(event, agentName);
        if (teamEvent) yield teamEvent;
      }

      // Write agent output to blackboard
      const outputKey = `execution_${agentName}`;
      bb.write(
        outputKey,
        { status: "completed", agentName, subTask },
        agentName,
      );

      yield {
        type: "agent_completed",
        agentName,
        output: `Completed: ${subTask}`,
        durationMs: 0,
      };

      // Send result back to orchestrator
      bus.send(agentName, "orchestrator", "result", {
        result: bb.read(outputKey),
      });
    } catch (err) {
      yield {
        type: "agent_error",
        agentName,
        error: err instanceof Error ? err.message : "Agent failed",
      };
    }
  }
}
