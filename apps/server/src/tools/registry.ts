// Tool Registry — central hub for registering, listing, and executing tools
// Singleton pattern: initialized once, used by ChatService and API routes
// V3: Returns ExecutionResult instead of string — enables structured status-aware
//     handling by circuit breaker, agent (degradation), and trace (observability)
import type { ToolDefinition } from "@agentforge/shared-types";
import type {
  RegisteredTool,
  ToolExecutor,
  CircuitBreakerState,
} from "./types.js";
import type { RunContext } from "../runtime/context.js";
import type { ExecutionResult } from "../runtime/results.js";
import {
  successResult,
  failedResult,
  cancelledResult,
  timeoutResult,
  executionResultToContent,
  ExecutionErrorCode,
} from "../runtime/results.js";
import { builtinTools } from "./builtins.js";
import { fileTools } from "./file-tools.js";
import { databaseTools } from "./database-tools.js";
import { networkTools } from "./network-tools.js";
import { sandboxTools } from "./sandbox-tools.js";
import { customerServiceTools } from "./customer-service-tools.js";
import { appGenTools } from "./app-gen-tools.js";
import { logger } from "@agentforge/logger";
import {
  toolCallsTotal,
  toolExecutionDurationMs,
  circuitBreakerState,
} from "../observability/metrics.js";

// Circuit breaker config
const CIRCUIT_BREAKER_THRESHOLD = 5; // consecutive failures
const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000; // 60 seconds

class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private circuitBreakers: Map<string, CircuitBreakerState> = new Map();
  private initialized = false;

  // Register all built-in tools (idempotent — safe to call multiple times)
  init(): void {
    if (this.initialized) return;

    const allTools = [
      ...builtinTools,
      ...fileTools,
      ...databaseTools,
      ...networkTools,
      ...sandboxTools,
      ...customerServiceTools,
      ...appGenTools,
    ];
    for (const tool of allTools) {
      this.register(tool);
    }
    this.initialized = true;
    logger.info(
      { count: this.tools.size, tools: this.listNames() },
      "Tools registered",
    );
  }

  // Register a single tool
  register(tool: RegisteredTool): void {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) {
      logger.warn({ tool: name }, "Tool already registered, overwriting");
    }
    this.tools.set(name, tool);
  }

  // Get all tool definitions (for sending to LLM)
  getDefinitions(enabledTools?: string[]): ToolDefinition[] {
    this.init();
    const definitions: ToolDefinition[] = [];
    for (const [name, tool] of this.tools) {
      if (!enabledTools || enabledTools.includes(name)) {
        definitions.push(tool.definition);
      }
    }
    return definitions;
  }

  /**
   * Execute a tool by name with arguments and runtime context.
   * Returns structured ExecutionResult (V3) instead of raw string.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: RunContext,
  ): Promise<ExecutionResult> {
    this.init();
    const tool = this.tools.get(name);
    if (!tool) {
      return failedResult(
        ExecutionErrorCode.NOT_FOUND,
        `Unknown tool "${name}". Available: ${this.listNames().join(", ")}`,
      );
    }

    // Check circuit breaker
    const breaker = this.circuitBreakers.get(name);
    if (breaker?.open) {
      const cooldownRemaining =
        CIRCUIT_BREAKER_COOLDOWN_MS - (Date.now() - breaker.openedAt);
      if (cooldownRemaining > 0) {
        return failedResult(
          ExecutionErrorCode.CIRCUIT_OPEN,
          `Tool "${name}" is temporarily disabled. Try again in ${Math.ceil(cooldownRemaining / 1000)}s.`,
        );
      }
      // Cooldown expired — close circuit
      this.circuitBreakers.set(name, {
        failures: 0,
        lastFailure: 0,
        open: false,
        openedAt: 0,
      });
    }

    // Fast path: check if already aborted before execution
    if (context.signal?.aborted) {
      return cancelledResult(`Tool "${name}" execution cancelled`);
    }

    // Execute with timeout + cancellation
    const timeout = tool.timeout || 30_000;
    try {
      const start = Date.now();
      const result = await this.executeWithTimeout(tool.execute, args, timeout, context);
      const duration = Date.now() - start;

      // Circuit breaker: reset on success or partial; trip on failed/timeout
      if (result.status === "success" || result.status === "partial") {
        if (breaker && breaker.failures > 0) {
          this.circuitBreakers.set(name, {
            failures: 0,
            lastFailure: 0,
            open: false,
            openedAt: 0,
          });
          circuitBreakerState.set({ tool_name: name }, 0);
        }
        toolCallsTotal.inc({ tool_name: name, status: result.status });
      } else {
        // failed / cancelled / timeout → increment circuit breaker
        this.incrementCircuitBreaker(name);
        toolCallsTotal.inc({ tool_name: name, status: result.status });
      }

      toolExecutionDurationMs.observe({ tool_name: name }, duration);

      logger.debug(
        {
          tool: name,
          args: JSON.stringify(args).slice(0, 100),
          status: result.status,
          output: executionResultToContent(result).slice(0, 80),
          durationMs: duration,
        },
        "Tool executed",
      );
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";

      // Update circuit breaker
      this.incrementCircuitBreaker(name);

      logger.error({ tool: name, error: msg }, "Tool execution failed");

      // Record timeout vs error
      const isTimeout = msg.includes("timed out");
      toolCallsTotal.inc({
        tool_name: name,
        status: isTimeout ? "timeout" : "error",
      });

      if (isTimeout) {
        return timeoutResult(timeout);
      }
      return failedResult(
        ExecutionErrorCode.EXECUTION_ERROR,
        `Error executing tool "${name}": ${msg}`,
      );
    }
  }

  // Execute with timeout + cancellation signal (unified via AbortSignal.any)
  private async executeWithTimeout(
    executor: ToolExecutor,
    args: Record<string, unknown>,
    timeoutMs: number,
    context: RunContext,
  ): Promise<ExecutionResult> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);

    const signals: AbortSignal[] = [timeoutSignal];
    if (context.signal) {
      signals.push(context.signal);
    }
    const combinedSignal =
      signals.length > 1
        ? AbortSignal.any(signals)
        : timeoutSignal;

    return new Promise<ExecutionResult>((resolve, reject) => {
      const onAbort = () => {
        const reason = timeoutSignal.aborted
          ? new Error(`Tool execution timed out after ${timeoutMs}ms`)
          : new DOMException("Aborted", "AbortError");
        reject(reason);
      };

      combinedSignal.addEventListener("abort", onAbort, { once: true });

      executor(args, context)
        .then((result) => {
          resolve(result);
        })
        .catch((err) => {
          reject(err);
        })
        .finally(() => {
          combinedSignal.removeEventListener("abort", onAbort);
        });
    });
  }

  // ── Circuit breaker helpers ──

  private incrementCircuitBreaker(name: string): void {
    const current = this.circuitBreakers.get(name) || {
      failures: 0,
      lastFailure: 0,
      open: false,
      openedAt: 0,
    };
    const failures = current.failures + 1;

    if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreakers.set(name, {
        failures,
        lastFailure: Date.now(),
        open: true,
        openedAt: Date.now(),
      });
      circuitBreakerState.set({ tool_name: name }, 1);
      logger.warn(
        { tool: name, failures },
        "Circuit breaker opened — too many consecutive failures",
      );
    } else {
      this.circuitBreakers.set(name, {
        ...current,
        failures,
        lastFailure: Date.now(),
      });
    }
  }

  // ── Query methods ──

  /** List all registered tool names */
  listNames(): string[] {
    this.init();
    return Array.from(this.tools.keys());
  }

  /** Get all registered tools (for API endpoint) — includes metadata */
  getAll(): RegisteredTool[] {
    this.init();
    return Array.from(this.tools.values());
  }

  /** Get circuit breaker states (for monitoring) */
  getCircuitBreakerStates(): Record<string, CircuitBreakerState> {
    return Object.fromEntries(this.circuitBreakers);
  }

  /** Reset circuit breaker for a tool (manual override) */
  resetCircuitBreaker(name: string): void {
    this.circuitBreakers.delete(name);
    circuitBreakerState.set({ tool_name: name }, 0);
    logger.info({ tool: name }, "Circuit breaker reset");
  }
}

// Singleton instance — imported and used throughout the app
export const toolRegistry = new ToolRegistry();

// Re-export types for convenience
export type { RegisteredTool, ToolExecutor };
