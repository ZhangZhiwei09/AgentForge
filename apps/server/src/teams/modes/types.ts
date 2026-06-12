// Mode Types — shared types for collaboration mode executors
import type { TeamDefinition, AgentRole, TeamStreamEvent } from "@agentforge/shared-types";
import type { MessageBus } from "../message-bus.js";
import type { Blackboard } from "../blackboard.js";

export interface ExecutionContext {
  teamRunId: string;
  conversationId: string;
  userId: string;
  definition: TeamDefinition;
  bus: MessageBus;
  blackboard: Blackboard;
  variables: Record<string, unknown>;
}

export interface CollaborationModeExecutor {
  /** Execute the team in this mode, yielding stream events */
  execute(
    definition: TeamDefinition,
    task: string,
    context: ExecutionContext,
  ): AsyncGenerator<TeamStreamEvent>;
}

/** Build enriched task prompt for an agent role */
export function buildAgentTask(
  role: AgentRole,
  task: string,
  blackboard: Blackboard,
  bus: MessageBus,
): string {
  return `
${role.systemPrompt}

## 当前 Blackboard（共享上下文）
${blackboard.toContextString()}

## 最近消息
${bus.getRecent(10).map(m =>
    `[${m.from}→${m.to}] ${m.type}: ${JSON.stringify(m.payload).substring(0, 200)}`
  ).join('\n')}

## 任务
${task}

请执行你的角色职责。使用 agent_decide 函数来报告你的决策。
`.trim();
}

/** Map agent names to roles from the definition */
export function getRoleByName(definition: TeamDefinition, name: string): AgentRole | undefined {
  return definition.agents.find((a) => a.name === name);
}
