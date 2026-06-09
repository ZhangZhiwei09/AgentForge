// Tool Calling types — shared between frontend and backend
// Follows OpenAI function calling format for compatibility

// JSON Schema type for tool parameters (simplified)
export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface JSONSchema {
  type: string;
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

// OpenAI-compatible tool function definition
export interface ToolFunctionDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

// Top-level tool definition sent to LLM
export interface ToolDefinition {
  type: "function";
  function: ToolFunctionDefinition;
}

// A tool call request from the LLM
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

// A tool execution result
export interface ToolResult {
  tool_call_id: string;
  name: string;
  result: string;
}

// SSE stream chunk: LLM requests a tool
export interface ToolCallChunk {
  type: "tool_call";
  tool_call: ToolCall;
  message_id?: string;
}

// SSE stream chunk: tool execution completed
export interface ToolResultChunk {
  type: "tool_result";
  tool_result: ToolResult;
  message_id?: string;
}
