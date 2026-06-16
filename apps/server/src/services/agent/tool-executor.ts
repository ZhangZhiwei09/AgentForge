// Tool execution with retry logic for AgentService ReAct loop
import { randomUUID } from "crypto";
import { toolRegistry } from "../../tools/registry.js";
import { logger } from "@agentforge/logger";
import { createChildContext, createRunContext, type RunContext } from "../../runtime/context.js";
import { classifyError } from "../error-classifier.js";
import { DEFAULT_TOOL_RETRY } from "../retry-executor.js";
import { buildDegradationMessage, getAlternativeTools } from "../degradation-chain.js";
import { executionResultToContent, ExecutionErrorCode, type ExecutionResult } from "../../runtime/results.js";
import type { ChatMessage } from "../../providers/types.js";

// Retry delay calculator (reuses dag-executor pattern)
export function calculateRetryDelayForAgent(
  retry: { backoff: string; initialDelay: number; maxDelay: number },
  attempt: number,
): number {
  switch (retry.backoff) {
    case "fixed":
      return retry.initialDelay;
    case "linear":
      return Math.min(retry.initialDelay * attempt, retry.maxDelay);
    case "exponential":
      return Math.min(
        retry.initialDelay * Math.pow(2, attempt - 1),
        retry.maxDelay,
      );
    default:
      return retry.initialDelay;
  }
}

/**
 * Delay helper for retry backoff.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a tool with retry logic and record the call + result in conversation messages.
 * On failure, builds a degradation message so the agent can try alternatives.
 * Shared by all ReAct loop methods to avoid duplicating tool execution logic.
 */
export async function executeToolWithRetry(
  toolName: string,
  args: Record<string, unknown>,
  conversationMessages: ChatMessage[],
  sessionId?: string,
  stepNumber?: number,
  parentContext?: RunContext,
): Promise<ExecutionResult> {
  let finalResult: ExecutionResult;
  let attempts = 0;
  let lastError: string = "";

  // Create child context for tool execution (adds to ancestry for tracing)
  const toolContext = parentContext
    ? createChildContext(parentContext)
    : createRunContext(new AbortController().signal);

  for (attempts = 0; attempts < DEFAULT_TOOL_RETRY.maxAttempts; attempts++) {
    try {
      finalResult = await toolRegistry.execute(toolName, args, toolContext);

      // Success — record in conversation (convert to string for LLM context)
      conversationMessages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: randomUUID(),
            type: "function" as const,
            function: { name: toolName, arguments: JSON.stringify(args) },
          },
        ],
      });
      conversationMessages.push({
        role: "tool",
        tool_call_id:
          conversationMessages[conversationMessages.length - 1].tool_calls![0]
            .id,
        content: executionResultToContent(finalResult),
      });

      if (attempts > 0) {
        logger.info(
          { tool: toolName, attempts: attempts + 1, sessionId },
          "Tool executed successfully after retry",
        );
      }
      return finalResult;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const classified = classifyError(error, "tool", toolName);
      lastError = classified.message;

      // Fatal — don't retry
      if (classified.category === "fatal") break;

      // Retryable or degradable — retry if attempts remain
      if (attempts < DEFAULT_TOOL_RETRY.maxAttempts - 1) {
        const delayMs = calculateRetryDelayForAgent(
          DEFAULT_TOOL_RETRY,
          attempts + 1,
        );
        logger.warn(
          {
            tool: toolName,
            attempt: attempts + 1,
            delayMs,
            error: classified.message,
            sessionId,
          },
          "Tool execution retry",
        );
        await delay(delayMs);
      }
    }
  }

  // All attempts exhausted or fatal — build degradation message
  logger.warn(
    { tool: toolName, attempts, lastError, sessionId },
    "Tool execution degraded after retries exhausted",
  );

  const classifiedFinal = classifyError(
    new Error(lastError),
    "tool",
    toolName,
  );
  const degradationMsg = buildDegradationMessage(
    classifiedFinal,
    toolName,
    attempts,
  );
  const alternatives = getAlternativeTools(toolName);

  // Record the degradation message as the tool result
  conversationMessages.push({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: randomUUID(),
        type: "function" as const,
        function: { name: toolName, arguments: JSON.stringify(args) },
      },
    ],
  });
  conversationMessages.push({
    role: "tool",
    tool_call_id:
      conversationMessages[conversationMessages.length - 1].tool_calls![0].id,
    content: degradationMsg,
  });

  // If alternatives exist, inject them as a hint
  if (alternatives.length > 0) {
    conversationMessages.push({
      role: "user",
      content: `[系统提示] 工具 "${toolName}" 不可用，你可以尝试替代工具：${alternatives.join(", ")}`,
    });
  }

  // Return degraded result as structured failed ExecutionResult
  return {
    status: "failed",
    error: {
      code: ExecutionErrorCode.EXECUTION_ERROR,
      message: degradationMsg,
      retryable: false,
    },
  } as ExecutionResult;
}
