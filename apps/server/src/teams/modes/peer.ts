// Peer-to-Peer Mode — equal agents communicate freely via message bus
// All agents start simultaneously; event-driven scheduling based on message routing
import type {
  TeamDefinition,
  TeamStreamEvent,
} from "@agentforge/shared-types";
import { AgentService } from "../../services/agent.js";
import type { CollaborationModeExecutor, ExecutionContext } from "./types.js";
import { buildAgentTask, toTeamEvent } from "./types.js";

export class PeerMode implements CollaborationModeExecutor {
  async *execute(
    definition: TeamDefinition,
    task: string,
    context: ExecutionContext,
  ): AsyncGenerator<TeamStreamEvent> {
    const bus = context.bus;
    const bb = context.blackboard;
    const maxRounds = definition.maxTotalIterations;

    bb.write("task", task, "system");

    yield {
      type: "team_started",
      teamRunId: context.teamRunId,
      teamName: definition.name,
      mode: "peer",
      agents: definition.agents.map((a) => ({ name: a.name, role: a.displayName })),
    };

    // In peer mode, agents run in rounds — each round, each agent gets a turn
    // Messages from other agents are included in context
    for (let round = 0; round < maxRounds; round++) {
      yield {
        type: "team_round_start",
        roundNumber: round + 1,
        totalRounds: maxRounds,
      };

      let conversationSettled = true;

      for (const agent of definition.agents) {
        // Check if there are new messages for this agent
        const recentMessages = bus.getHistory().filter(
          (m) => m.to === agent.name || m.to === "broadcast",
        );

        // Build task with message context
        const peerTask = buildAgentTask(agent, task, bb, bus);

        yield {
          type: "agent_started",
          agentName: agent.name,
          role: agent.displayName,
          task: peerTask,
        };

        const agentService = new AgentService();

        try {
          for await (const event of agentService.run(context.conversationId, peerTask, {
            maxIterations: agent.maxIterations,
            tools: agent.tools.length > 0 ? agent.tools : null,
          })) {
            const teamEvent = toTeamEvent(event, agent.name);
            if (teamEvent) yield teamEvent;

            // If agent responds with content, broadcast to peers
            if (event.type === "agent_respond" && agent.canBroadcast) {
              const content = event.content || event.summary || "";
              bus.send(agent.name, "broadcast", "broadcast", {
                context: { message: content },
              });

              yield {
                type: "agent_message",
                from: agent.name,
                to: "broadcast",
                msgType: "broadcast",
                payload: { context: { message: content } },
                timestamp: new Date().toISOString(),
              };
            }
          }

          yield {
            type: "agent_completed",
            agentName: agent.name,
            output: "Peer round completed",
            durationMs: 0,
          };

        } catch (err) {
          yield {
            type: "agent_error",
            agentName: agent.name,
            error: err instanceof Error ? err.message : "Peer agent failed",
          };

          if (definition.onFailure === "stop") {
            yield { type: "team_failed", error: `Agent "${agent.name}" failed` };
            return;
          }
        }
      }

      // Check for natural termination: no new messages in this round
      const newMessageCount = bus.count;
      if (newMessageCount === 0 || conversationSettled) {
        break;
      }
    }

    yield {
      type: "team_completed",
      output: bb.snapshot(),
      totalDurationMs: 0,
      roundsCount: 0,
    };
  }
}
