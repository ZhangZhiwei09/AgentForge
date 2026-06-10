// Tool Registry — central hub for registering, listing, and executing tools
// Singleton pattern: initialized once, used by ChatService and API routes
// V2: Added risk levels, per-tool timeouts, and circuit breaker pattern
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool, ToolExecutor, CircuitBreakerState } from "./types.js";
import { builtinTools } from "./builtins.js";
import { fileTools } from "./file-tools.js";
import { logger } from "@agentforge/logger";

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

    const allTools = [...builtinTools, ...fileTools];
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

  // Execute a tool by name with arguments
  // Supports: circuit breaker, per-tool timeout, error tracking
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    this.init();
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: unknown tool "${name}". Available: ${this.listNames().join(", ")}`;
    }

    // Check circuit breaker
    const breaker = this.circuitBreakers.get(name);
    if (breaker?.open) {
      const cooldownRemaining =
        CIRCUIT_BREAKER_COOLDOWN_MS - (Date.now() - breaker.openedAt);
      if (cooldownRemaining > 0) {
        return `Error: tool "${name}" is temporarily disabled (circuit breaker open). Try again in ${Math.ceil(cooldownRemaining / 1000)}s.`;
      }
      // Cooldown expired — close circuit
      this.circuitBreakers.set(name, {
        failures: 0,
        lastFailure: 0,
        open: false,
        openedAt: 0,
      });
    }

    // Execute with timeout
    const timeout = tool.timeout || 30_000;
    try {
      const start = Date.now();
      const result = await this.executeWithTimeout(tool.execute, args, timeout);
      const duration = Date.now() - start;

      // Reset circuit breaker on success
      if (breaker && breaker.failures > 0) {
        this.circuitBreakers.set(name, {
          failures: 0,
          lastFailure: 0,
          open: false,
          openedAt: 0,
        });
      }

      logger.debug(
        {
          tool: name,
          args: JSON.stringify(args).slice(0, 100),
          result: result.slice(0, 80),
          durationMs: duration,
        },
        "Tool executed",
      );
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";

      // Update circuit breaker
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

      logger.error({ tool: name, error: msg }, "Tool execution failed");
      return `Error executing tool "${name}": ${msg}`;
    }
  }

  // Execute with a timeout — if the tool takes too long, reject
  private async executeWithTimeout(
    executor: ToolExecutor,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      executor(args)
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

  // List all registered tool names
  listNames(): string[] {
    this.init();
    return Array.from(this.tools.keys());
  }

  // Get all registered tools (for API endpoint) — includes metadata
  getAll(): RegisteredTool[] {
    this.init();
    return Array.from(this.tools.values());
  }

  // Get circuit breaker states (for monitoring)
  getCircuitBreakerStates(): Record<string, CircuitBreakerState> {
    return Object.fromEntries(this.circuitBreakers);
  }

  // Reset circuit breaker for a tool (manual override)
  resetCircuitBreaker(name: string): void {
    this.circuitBreakers.delete(name);
    logger.info({ tool: name }, "Circuit breaker reset");
  }
}

// Singleton instance — imported and used throughout the app
export const toolRegistry = new ToolRegistry();

// Re-export types for convenience
export type { RegisteredTool, ToolExecutor };
