// Server-side tool types — extends shared tool types with execution contracts
import type { ToolDefinition } from "@agentforge/shared-types";

// A tool executor function: receives parsed arguments, returns result string
export type ToolExecutor = (args: Record<string, unknown>) => Promise<string>;

// Registered tool combines the definition with its executor
export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
}
