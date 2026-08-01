// Server-side tool types — extends shared tool types with execution contracts
import type { ToolDefinition } from "@agentforge/shared-types";

// Tool risk level for approval gates and sandboxing
export type RiskLevel = "safe" | "read_only" | "mutation" | "destructive";

// Default timeouts by risk level (ms)
export const RISK_TIMEOUTS: Record<RiskLevel, number> = {
  safe: 5_000,
  read_only: 15_000,
  mutation: 30_000,
  destructive: 60_000,
};

import type { RunContext } from "../runtime/context.js";
import type { ExecutionResult } from "../runtime/results.js";

// A tool executor function: receives parsed arguments and runtime context, returns structured result
// V3: Returns ExecutionResult instead of string — enables structured status-aware handling
//   by the registry (circuit breaker), agent (degradation), and trace (observability)
export type ToolExecutor = (
  args: Record<string, unknown>,
  context: RunContext,
) => Promise<ExecutionResult>;

// Registered tool combines the definition with its executor and metadata
export interface RegisteredTool {
  definition: ToolDefinition;
  execute: ToolExecutor;
  riskLevel: RiskLevel;
  timeout: number; // ms
  requireApproval: boolean;
  category: string; // e.g. "utility", "file", "network", "database", "sandbox"
  parallelizable: boolean; // true if this tool can be executed in parallel with others
  sandbox?: boolean; // true if this tool requires Docker sandbox isolation
}

// Circuit breaker state for a tool
export interface CircuitBreakerState {
  failures: number;
  lastFailure: number; // timestamp
  open: boolean;
  openedAt: number; // timestamp when circuit opened
}
