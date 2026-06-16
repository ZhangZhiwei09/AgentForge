// Tool Registry — central hub for registering, listing, and executing tools
// Singleton pattern: initialized once, used by ChatService and API routes
// V3: Returns ExecutionResult instead of string — enables structured status-aware
//     handling by circuit breaker, agent (degradation), and trace (observability)
//
// V4: Category-based tool organization — builtin (runtime core) vs business (per-scenario)

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
import { appGenTools } from "./app-gen-tools.js";
import { searchKnowledgeBaseTool } from "./builtin/search-knowledge-base.js";
import { createSupportTicketTool } from "./business/create-ticket.js";
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

  // Register all tools (idempotent — safe to call multiple times)
  init(): void {
    if (this.initialized) return;

    const allTools = [
      ...builtinTools,
      ...fileTools,
      ...databaseTools,
      ...networkTools,
      ...sandboxTools,
      ...appGenTools,
      // ── Agent Runtime 工具分层 ──
      searchKnowledgeBaseTool,     // Builtin: KB 检索（Runtime 核心）
      createSupportTicketTool,      // Business: 工单创建
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
      this.circuitBreakers.set(name, {
        failures: 0,
        lastFailure: 0,
        open: false,
        openedAt: 0,
      });
    }

    if (context.signal?.aborted) {
      return cancelledResult(`Tool "${name}" execution cancelled`);
    }

    const timeout = tool.timeout || 30_000;
    try {
      const start = Date.now();
      const result = await this.executeWithTimeout(tool.execute, args, timeout, context);
      const duration = Date.now() - start;

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
      this.incrementCircuitBreaker(name);
      logger.error({ tool: name, error: msg }, "Tool execution failed");
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

  listNames(): string[] {
    this.init();
    return Array.from(this.tools.keys());
  }

  getAll(): RegisteredTool[] {
    this.init();
    return Array.from(this.tools.values());
  }

  /** Get tools by category (builtin, business, utility, file, etc.) */
  getByCategory(category: string): RegisteredTool[] {
    this.init();
    return Array.from(this.tools.values()).filter(
      (t) => t.category === category,
    );
  }

  /** Get all tool categories with counts */
  getCategories(): Array<{ category: string; count: number }> {
    this.init();
    const map = new Map<string, number>();
    for (const tool of this.tools.values()) {
      map.set(tool.category, (map.get(tool.category) || 0) + 1);
    }
    return Array.from(map.entries()).map(([category, count]) => ({
      category,
      count,
    }));
  }

  getCircuitBreakerStates(): Record<string, CircuitBreakerState> {
    return Object.fromEntries(this.circuitBreakers);
  }

  resetCircuitBreaker(name: string): void {
    this.circuitBreakers.delete(name);
    circuitBreakerState.set({ tool_name: name }, 0);
    logger.info({ tool: name }, "Circuit breaker reset");
  }
}

// Singleton instance
export const toolRegistry = new ToolRegistry();

export type { RegisteredTool, ToolExecutor };
