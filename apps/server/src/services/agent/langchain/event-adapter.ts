// EventAdapter — Bridges LangGraph execution events to AgentStreamEvent.
//
// This is the critical Layer 1 parity boundary (§14.4):
//   LangGraph node outputs MUST produce the exact same AgentStreamEvent
//   sequence as LegacyAgentRunner for the same LLM inputs.
//
// Phase 2 will implement:
//   - LangGraph node transition → AgentStreamEvent mapping
//   - Event ordering enforcement (meta first, responding→respond order, etc.)
//   - clear_stream injection on JSON leak, degrade, and respond-only transitions
//
// Phase 1: Skeleton only.

import type { AgentStreamEvent } from "@agentforge/shared-types";

/** Stub — Phase 2 implementation */
export function langGraphNodeToAgentEvent(
  _nodeName: string,
  _nodeOutput: unknown,
): AgentStreamEvent | null {
  // Phase 2: Map each graph node's output to the corresponding AgentStreamEvent
  //   decide → agent_think, agent_act
  //   tool_execute → agent_observe, agent_approval_required
  //   respond → agent_responding, agent_respond
  //   ask_user → agent_ask_user
  //   degrade → agent_degraded
  //   fail → agent_error
  return null;
}
