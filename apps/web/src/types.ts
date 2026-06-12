import type {
  Conversation,
  DebugInfo,
  Memory,
  MemoryInfo,
  MemorySearchResult,
  Message,
  ModelInfo,
  ProviderType,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from "@agentforge/shared-types";

export type {
  Conversation,
  DebugInfo,
  Memory,
  MemoryInfo,
  MemorySearchResult,
  Message,
  ModelInfo,
  ProviderType,
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
