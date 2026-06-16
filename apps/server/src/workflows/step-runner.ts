// Step Runner — pure functions for executing workflow steps with retry, timeout, and fallback logic
import type {
  WorkflowStep,
  StepResult,
  WorkflowDefinition,
} from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import type { StepHandler, StepContext } from "./handlers/index.js";

/**
 * Execute a single workflow step (no retry, no timeout — those are handled by executeWithRetry).
 */
export async function executeSingleStep(
  step: WorkflowStep,
  context: StepContext,
  handlers: Record<string, StepHandler>,
): Promise<StepResult> {
  const handler = handlers[step.type];
  if (!handler) {
    return {
      status: "failed",
      output: null,
      error: `Unknown step type: ${step.type}`,
    };
  }

  try {
    return await handler.execute(step, context);
  } catch (err) {
    return {
      status: "failed",
      output: null,
      error: err instanceof Error ? err.message : "Step handler error",
    };
  }
}

/**
 * Execute a single step with timeout enforcement.
 */
export async function executeSingleStepWithTimeout(
  step: WorkflowStep,
  context: StepContext,
  handlers: Record<string, StepHandler>,
): Promise<StepResult> {
  const timeoutMs = (step.timeout || 60) * 1000;

  return new Promise<StepResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`Step ${step.id} timed out after ${step.timeout || 60}s`),
      );
    }, timeoutMs);

    executeSingleStep(step, context, handlers)
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Execute a single step with retry logic.
 */
export async function executeWithRetry(
  step: WorkflowStep,
  context: StepContext,
  handlers: Record<string, StepHandler>,
  definition?: WorkflowDefinition,
): Promise<StepResult> {
  const retry = step.retry || {
    maxAttempts: 1,
    backoff: "fixed" as const,
    initialDelay: 0,
    maxDelay: 0,
    retryOn: [],
  };
  const maxAttempts = retry.maxAttempts || 1;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await executeSingleStepWithTimeout(step, context, handlers);
      return { ...result, retryCount: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Check if we should retry
      if (attempt < maxAttempts - 1) {
        const delay = calculateRetryDelay(retry, attempt + 1);
        logger.warn(
          {
            stepId: step.id,
            attempt: attempt + 1,
            maxAttempts,
            delayMs: delay,
          },
          "Retrying failed step",
        );
        await sleep(delay);
      }
    }
  }

  // All retries exhausted — check timeout handling
  if (lastError?.message?.includes("timed out")) {
    const onTimeout = step.on_timeout || "fail";
    if (onTimeout === "skip") {
      return {
        status: "skipped",
        output: null,
        reason: `timeout after ${step.timeout || 60}s`,
        retryCount: maxAttempts,
      };
    }
    if (onTimeout === "fallback" && step.fallback_step && definition) {
      const fallbackStep = definition.steps.find(
        (s: WorkflowStep) => s.id === step.fallback_step,
      );
      if (fallbackStep) {
        logger.info(
          { stepId: step.id, fallbackStepId: fallbackStep.id },
          "Executing fallback step",
        );
        try {
          const fbResult = await executeWithRetry(
            fallbackStep,
            context,
            handlers,
            definition,
          );
          return { ...fbResult, retryCount: maxAttempts };
        } catch (err: unknown) {
          logger.error(
            { err, stepId: step.id, fallbackStepId: fallbackStep.id },
            "Fallback step execution failed",
          );
          return {
            status: "failed",
            output: null,
            error: `Fallback step "${fallbackStep.id}" also failed`,
            retryCount: maxAttempts,
          };
        }
      }
    }
  }

  return {
    status: "failed",
    output: null,
    error: lastError?.message || "Step execution failed after retries",
    retryCount: maxAttempts,
  };
}

/**
 * Calculate delay before next retry based on backoff strategy.
 */
export function calculateRetryDelay(
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
