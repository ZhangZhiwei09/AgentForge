// CodeGen LLM caller — shared LLM invocation for code generation
// Extracted from services/codegen.ts — Phase 3 file splitting

import { getProvider, resolveModel } from "../../providers/registry.js";
import type { ChatMessage } from "../../providers/types.js";

/**
 * Type alias for the callLLM function signature.
 * Used by plan.ts, generate.ts, and review.ts to receive callLLM as a dependency.
 */
export type CodeGenLLMCaller = (
  messages: ChatMessage[],
  model: string,
  systemPrompt: string,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Simple LLM call — collects token chunks, no tool calling.
 */
export async function callLLM(
  messages: ChatMessage[],
  model: string,
  systemPrompt: string,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const [providerName, resolvedModel] = resolveModel(model);
  const provider = getProvider(providerName);

  const stream = provider.streamChat(
    messages,
    resolvedModel,
    systemPrompt,
    temperature,
    maxTokens,
    undefined, // No tools — direct prompting
    signal, // Pass AbortSignal for cancellation support
  );

  let content = "";
  for await (const chunk of stream) {
    if (chunk.type === "token" && chunk.content) {
      content += chunk.content;
    }
  }

  if (!content || content.trim().length === 0) {
    throw new Error("LLM returned empty response");
  }

  return content;
}
