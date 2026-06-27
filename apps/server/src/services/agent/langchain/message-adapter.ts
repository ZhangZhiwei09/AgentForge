// MessageAdapter — Bridges AgentForge ChatMessage to LangChain BaseMessage types.
//
// Phase 2 will implement:
//   - ChatMessage (our provider type) → LangChain HumanMessage/AIMessage/SystemMessage/ToolMessage
//   - LangChain BaseMessage → ChatMessage (for tool execution context)
//   - Tool call handling: our tool_calls format ↔ LangChain tool_call_blocks
//
// Phase 1: Skeleton only.

import type { ChatMessage } from "../../../providers/types.js";

/** Stub — Phase 2 implementation */
export function chatMessageToLangChain(message: ChatMessage): Record<string, unknown> {
  // Phase 2: Map role + content to appropriate LangChain message class
  return message as unknown as Record<string, unknown>;
}

/** Stub — Phase 2 implementation */
export function langChainToChatMessage(
  _lcMessage: Record<string, unknown>,
): ChatMessage {
  // Phase 2: Reverse mapping from LangChain message to our ChatMessage
  throw new Error("Not implemented in Phase 1");
}
