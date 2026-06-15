// Debate Mode — pro vs con agents debate in parallel, judge rules at the end
// Pro and Con agents run concurrently for N rounds each, then Judge evaluates
import type {
  TeamDefinition,
  TeamStreamEvent,
  AgentRole,
} from "@agentforge/shared-types";
import { AgentService } from "../../services/agent.js";
import type { CollaborationModeExecutor, ExecutionContext } from "./types.js";
import { buildAgentTask, getRoleByName, toTeamEvent } from "./types.js";

export class DebateMode implements CollaborationModeExecutor {
  async *execute(
    definition: TeamDefinition,
    task: string,
    context: ExecutionContext,
  ): AsyncGenerator<TeamStreamEvent> {
    const bus = context.bus;
    const bb = context.blackboard;

    const debate = definition.debate;
    if (!debate) {
      yield {
        type: "team_failed",
        error: "Debate mode requires debate config",
      };
      return;
    }

    const proRole = getRoleByName(definition, debate.proAgent);
    const conRole = getRoleByName(definition, debate.conAgent);
    const judgeRole = getRoleByName(definition, debate.judgeAgent);

    if (!proRole || !conRole || !judgeRole) {
      yield {
        type: "team_failed",
        error: "Debate mode: pro, con, or judge agent not found",
      };
      return;
    }

    bb.write("debate_question", debate.question || task, "system");

    yield {
      type: "team_started",
      teamRunId: context.teamRunId,
      teamName: definition.name,
      mode: "debate",
      agents: definition.agents.map((a) => ({
        name: a.name,
        role: a.displayName,
      })),
    };

    // ---- Phase 1: Parallel Debate Rounds ----
    const maxDebateRounds = debate.maxRounds || 3;

    for (let round = 0; round < maxDebateRounds; round++) {
      yield {
        type: "team_round_start",
        roundNumber: round + 1,
        totalRounds: maxDebateRounds,
      };

      // Run Pro and Con in parallel
      const proResult = await this.runDebater(
        proRole,
        "pro",
        debate.question,
        round + 1,
        context,
        bb,
        bus,
      );
      const conResult = await this.runDebater(
        conRole,
        "con",
        debate.question,
        round + 1,
        context,
        bb,
        bus,
      );

      // Yield the combined results
      for (const event of [
        ...(proResult.events || []),
        ...(conResult.events || []),
      ]) {
        yield event;
      }

      // Store arguments on blackboard
      bb.write(`pro_argument_${round + 1}`, proResult.output, proRole.name);
      bb.write(`con_argument_${round + 1}`, conResult.output, conRole.name);

      // Cross-share arguments
      bus.send(proRole.name, conRole.name, "feedback", {
        context: {
          pro_argument: proResult.output,
          con_argument: conResult.output,
        },
      });
    }

    // ---- Phase 2: Judge Evaluation ----
    yield {
      type: "team_round_start",
      roundNumber: maxDebateRounds + 1,
      totalRounds: maxDebateRounds + 1,
    };

    const judgeTask = buildAgentTask(
      judgeRole,
      `
辩论题目: ${debate.question}

## 正方 (Pro: ${proRole.displayName}) 论点
${bb.read("pro_argument_1") || ""}

## 反方 (Con: ${conRole.displayName}) 论点
${bb.read("con_argument_1") || ""}

请基于双方的论点进行裁判，输出你的裁决结果。
以 JSON 格式输出:
{
  "winner": "pro" | "con" | "tie",
  "reasoning": "裁决理由",
  "score": { "pro": 1-10, "con": 1-10 },
  "keyFactors": ["关键因素1", "关键因素2"],
  "recommendation": "建议"
}
`.trim(),
      bb,
      bus,
    );

    yield {
      type: "agent_started",
      agentName: judgeRole.name,
      role: judgeRole.displayName,
      task: "Judge evaluation",
    };

    const agentService = new AgentService();
    let judgeOutput: string | null = null;

    try {
      for await (const event of agentService.run(
        context.conversationId,
        judgeTask,
        {
          maxIterations: judgeRole.maxIterations,
          tools: judgeRole.tools.length > 0 ? judgeRole.tools : null,
          scope: context.scope,
        },
      )) {
        const teamEvent = toTeamEvent(event, judgeRole.name);
        if (teamEvent) yield teamEvent;
        if (event.type === "agent_respond") {
          judgeOutput = event.content || event.summary || null;
        }
      }

      bb.write("verdict", judgeOutput || "No verdict", judgeRole.name);

      yield {
        type: "agent_completed",
        agentName: judgeRole.name,
        output: judgeOutput || "",
        durationMs: 0,
      };
    } catch (err) {
      yield {
        type: "agent_error",
        agentName: judgeRole.name,
        error: err instanceof Error ? err.message : "Judge failed",
      };
    }

    // ---- Complete ----
    yield {
      type: "team_completed",
      output: {
        question: debate.question,
        verdict: bb.read("verdict"),
        proArguments: bb.read("pro_argument_1"),
        conArguments: bb.read("con_argument_1"),
      },
      totalDurationMs: 0,
      roundsCount: maxDebateRounds + 1,
    };
  }

  /** Run a single debater (pro or con) */
  private async runDebater(
    role: AgentRole,
    side: "pro" | "con",
    question: string,
    round: number,
    context: ExecutionContext,
    bb: typeof context.blackboard,
    bus: typeof context.bus,
  ): Promise<{ output: string; events: TeamStreamEvent[] }> {
    const events: TeamStreamEvent[] = [];

    const sidePrompt =
      side === "pro"
        ? `你代表正方。请为以下论点提供支持和论据。`
        : `你代表反方。请反驳正方观点并提供反对论据。`;

    const debaterTask = `
${role.systemPrompt}

## 辩论
${sidePrompt}

## 辩论题目
${question}

## 当前 Blackboard
${bb.toContextString()}

## 第 ${round} 轮
请提出你的论点。
`.trim();

    events.push({
      type: "agent_started",
      agentName: role.name,
      role: role.displayName,
      task: `Debate round ${round} (${side})`,
    });

    const agentService = new AgentService();
    let output = "";

    try {
      for await (const event of agentService.run(
        context.conversationId,
        debaterTask,
        {
          maxIterations: role.maxIterations,
          tools: role.tools.length > 0 ? role.tools : null,
          scope: context.scope,
        },
      )) {
        const teamEvent = toTeamEvent(event, role.name);
        if (teamEvent) events.push(teamEvent);
        if (event.type === "agent_respond") {
          output = event.content || event.summary || "";
        }
      }

      events.push({
        type: "agent_completed",
        agentName: role.name,
        output,
        durationMs: 0,
      });
    } catch (err) {
      events.push({
        type: "agent_error",
        agentName: role.name,
        error: err instanceof Error ? err.message : "Debater failed",
      });
    }

    return { output, events };
  }
}
