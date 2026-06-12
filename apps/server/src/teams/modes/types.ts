// Mode Types — shared types for collaboration mode executors
import type { TeamDefinition, AgentRole, TeamStreamEvent, AgentStreamEvent } from "@agentforge/shared-types";
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

/** Event types forwarded from agent stream to team stream */
const FORWARDED_EVENT_TYPES = new Set([
  "agent_think",
  "agent_plan",
  "agent_act",
  "agent_observe",
]);

/**
 * Convert an agent stream event to a team stream event if it's a forwardable type.
 * Returns null for events that shouldn't be forwarded (e.g., agent_respond, agent_token).
 *
 * Usage in mode executors:
 *   for await (const event of agentService.run(...)) {
 *     const teamEvent = toTeamEvent(event, agentName);
 *     if (teamEvent) yield teamEvent;
 *     if (event.type === "agent_respond") { output = event.content; }
 *   }
 */
export function toTeamEvent(
  event: AgentStreamEvent,
  agentName: string,
): TeamStreamEvent | null {
  const { type } = event;
  if (!FORWARDED_EVENT_TYPES.has(type)) return null;
  // Destructure to exclude the discriminant from spread
  const { type: _, ...rest } = event as unknown as Record<string, unknown>;
  return { type, agentName, ...rest } as TeamStreamEvent;
}
