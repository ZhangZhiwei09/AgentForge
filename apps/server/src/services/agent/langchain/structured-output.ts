// StructuredOutput — Bridges decision-parser output to LangChain structured output.
//
// Phase 2 will implement:
//   - Zod schema for agent_decide structured output → LangChain withStructuredOutput
//   - Decision validation using our parseAgentDecideFromArgs
//   - Flat JSON structure enforcement (not nested under "decision" key)
//
// Phase 1: Skeleton only.

import type { AgentStep } from "@agentforge/shared-types";

/** Stub — Phase 2 implementation */
export function parseDecisionFromLangGraphOutput(
  _output: Record<string, unknown>,
  _step: number,
): AgentStep | null {
  // Phase 2: Parse LangGraph structured output node result into AgentStep
  // Uses the same parseAgentDecideFromArgs logic — flat JSON, no nesting
  return null;
}
