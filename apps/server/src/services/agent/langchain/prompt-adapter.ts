// PromptAdapter — Bridges AgentForge prompt system to LangChain PromptTemplate.
//
// Phase 2 will implement:
//   - Convert AgentForge iteration-context strings to LangChain ChatPromptTemplate
//   - Support ChatMessage[] ↔ LangChain MessageLike conversion
//   - Ensure all LLM-facing text remains Chinese (per Guardrail 9)
//
// Phase 1: Skeleton only. LangGraphAgentRunner does not exist yet.

import type { ChatMessage } from "../../../providers/types.js";

/** Stub — Phase 2 implementation */
export function toLangChainMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  // Phase 2: Convert AgentForge ChatMessage[] to LangChain BaseMessage[]
  // using @langchain/core message classes (HumanMessage, AIMessage, SystemMessage)
  return messages as unknown as Array<Record<string, unknown>>;
}

/** Stub — Phase 2 implementation */
export function buildChatPromptTemplate(
  systemPrompt: string,
): Record<string, unknown> {
  // Phase 2: Create ChatPromptTemplate from system prompt string
  return { system: systemPrompt } as unknown as Record<string, unknown>;
}
