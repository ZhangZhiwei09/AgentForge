// Tool Registry — central hub for registering, listing, and executing tools
// Singleton pattern: initialized once, used by ChatService and API routes
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool, ToolExecutor } from "./types.js";
import { builtinTools } from "./builtins.js";
import { logger } from "@agentforge/logger";

class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private initialized = false;

  // Register all built-in tools (idempotent — safe to call multiple times)
  init(): void {
    if (this.initialized) return;
    for (const tool of builtinTools) {
      this.register(tool);
    }
    this.initialized = true;
    logger.info({ count: this.tools.size, tools: this.listNames() }, "Tools registered");
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
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    this.init();
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: unknown tool "${name}". Available: ${this.listNames().join(", ")}`;
    }
    try {
      const start = Date.now();
      const result = await tool.execute(args);
      const duration = Date.now() - start;
      logger.debug({ tool: name, args, result: result.slice(0, 80), durationMs: duration }, "Tool executed");
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error({ tool: name, error: msg }, "Tool execution failed");
      return `Error executing tool "${name}": ${msg}`;
    }
  }

  // List all registered tool names
  listNames(): string[] {
    this.init();
    return Array.from(this.tools.keys());
  }

  // Get all registered tools (for API endpoint)
  getAll(): RegisteredTool[] {
    this.init();
    return Array.from(this.tools.values());
  }
}

// Singleton instance — imported and used throughout the app
export const toolRegistry = new ToolRegistry();

// Re-export types for convenience
export type { RegisteredTool, ToolExecutor };
