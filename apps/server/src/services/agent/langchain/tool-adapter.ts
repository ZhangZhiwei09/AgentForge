// ToolAdapter — Wraps AgentForge ToolRegistry tools as LangChain StructuredTool.
//
// CRITICAL (per Guardrail 5): LangChain Tool adapter is a BRIDGE only —
// actual tool execution must ALWAYS go through toolRegistry.execute().
// The call chain: GraphToolAdapter → executeToolWithRetry → toolRegistry.execute()
//
// Phase 2 will implement:
//   - Convert toolRegistry tool definitions to LangChain DynamicStructuredTool
//   - Wrap executeToolWithRetry as the tool's func callback
//   - Preserve circuit breaker, timeout, cancel, and metrics from toolRegistry
//
// Phase 1: Skeleton only.

/** Stub — Phase 2 implementation */
export function buildLangChainTools(
  _toolNames?: string[] | null,
): Array<Record<string, unknown>> {
  // Phase 2: For each tool in toolRegistry, create a LangChain DynamicStructuredTool
  // whose func delegates to executeToolWithRetry → toolRegistry.execute()
  return [];
}

/** Stub — Phase 2 implementation */
export function toolRegistryExecute(
  _toolName: string,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Phase 2: Bridge — delegates to toolRegistry.execute() with full governance
  throw new Error("Not implemented in Phase 1");
}
