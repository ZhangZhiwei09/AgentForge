import type {
  DebugInfo,
  Memory,
  MemoryInfo,
  MemorySearchResult,
  Message,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from "@agentforge/shared-types";

export type {
  DebugInfo,
  Memory,
  MemoryInfo,
  MemorySearchResult,
  Message,
  ToolDefinition,
  ToolCall,
  ToolResult,
};

// Frontend-only type for tracking tool calls during streaming
export interface ToolCallRecord {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  status: "pending" | "done" | "error";
}
