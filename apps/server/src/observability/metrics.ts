// Prometheus metrics — all application-level metrics defined with prom-client
// Exposed at GET /api/metrics for Prometheus scraping
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from "prom-client";
import type { Hono } from "hono";

// ---- Default Labels ----

const defaultLabels = {
  app: "agentforge",
} as const;

// ---- Registry ----

// Use the default global registry (prom-client's built-in), but apply our labels
const registry = new Registry();
registry.setDefaultLabels(defaultLabels);

// Register default Node.js metrics (event loop lag, GC, heap, open handles, etc.)
collectDefaultMetrics({ register: registry, prefix: "agentforge_" });

// ---- HTTP Metrics ----

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "path", "status"],
  registers: [registry],
});

export const httpRequestDurationMs = new Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration in milliseconds",
  labelNames: ["method", "path"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

// ---- Tool Metrics ----

export const toolCallsTotal = new Counter({
  name: "tool_calls_total",
  help: "Total number of tool executions",
  labelNames: ["tool_name", "status"], // status = success | error | timeout
  registers: [registry],
});

export const toolExecutionDurationMs = new Histogram({
  name: "tool_execution_duration_ms",
  help: "Tool execution duration in milliseconds",
  labelNames: ["tool_name"],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000],
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: "circuit_breaker_state",
  help: "Circuit breaker state per tool (0=closed, 1=open)",
  labelNames: ["tool_name"],
  registers: [registry],
});

// ---- MCP Monitoring Metrics (CR4) ----

export const mcpCallTotal = new Counter({
  name: "mcp_call_total",
  help: "Total number of MCP monitoring service calls",
  labelNames: ["tool_name", "status"], // status = success | error
  registers: [registry],
});

export const mcpCallDurationMs = new Histogram({
  name: "mcp_call_duration_ms",
  help: "MCP monitoring service call duration in milliseconds",
  labelNames: ["tool_name"],
  buckets: [5, 20, 50, 100, 250, 500, 1000, 2000, 3000, 5000, 10000],
  registers: [registry],
});

export const mcpCallError = new Counter({
  name: "mcp_call_error_total",
  help: "MCP monitoring service call errors",
  labelNames: ["tool_name", "code"], // code = TIMEOUT | NETWORK_ERROR | API_ERROR | NOT_CONNECTED
  registers: [registry],
});

// ---- Workflow Metrics (V6) ----

export const workflowRunsTotal = new Counter({
  name: "workflow_runs_total",
  help: "Total number of workflow runs",
  labelNames: ["status"], // status = running | completed | failed | cancelled
  registers: [registry],
});

export const workflowStepDurationMs = new Histogram({
  name: "workflow_step_duration_ms",
  help: "Workflow step execution duration in milliseconds",
  labelNames: ["step_type"], // step_type = agent | tool | condition | parallel | human_approval | transform
  buckets: [100, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000],
  registers: [registry],
});

export const workflowSuccessRate = new Gauge({
  name: "workflow_success_rate",
  help: "Workflow success rate (0.0 to 1.0)",
  labelNames: [] as const,
  registers: [registry],
});

// ---- Agent Runtime Metrics ----

/** Agent Runtime 消息路由分类统计 */
export const agentRouteClassificationTotal = new Counter({
  name: "agent_route_classification_total",
  help: "Agent Runtime route classification count by route and source",
  labelNames: ["route", "source"],
  registers: [registry],
});

/** Agent Runtime 路由分类置信度分布 */
export const agentRouteConfidence = new Histogram({
  name: "agent_route_confidence",
  help: "Agent Runtime route classification confidence distribution",
  labelNames: ["route"],
  buckets: [0.1, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 1.0],
  registers: [registry],
});

/** L2 语义路由 k-NN 匹配相似度分布 */
export const agentRouteL2Similarity = new Histogram({
  name: "agent_route_l2_similarity",
  help: "L2 semantic router top-K match similarity distribution",
  labelNames: ["route"],
  buckets: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95],
  registers: [registry],
});

/** L2 语义路由分类时延 */
export const agentRouteL2LatencyMs = new Histogram({
  name: "agent_route_l2_latency_ms",
  help: "L2 semantic router classification latency in ms",
  labelNames: ["outcome"],
  buckets: [5, 10, 20, 30, 50, 100, 200, 500],
  registers: [registry],
});

/** Agent Runtime ReAct 循环迭代次数分布 */
export const agentReActIterations = new Histogram({
  name: "agent_react_iterations",
  help: "Agent Runtime ReAct loop iteration count",
  labelNames: ["agent_type"],
  buckets: [1, 2, 3, 4, 5, 7, 10],
  registers: [registry],
});

/** Agent Runtime 回复引证覆盖率 */
export const agentCitationCoverage = new Histogram({
  name: "agent_citation_coverage",
  help: "Agent Runtime response citation coverage rate",
  labelNames: ["level"],
  buckets: [0, 0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
});

/** Agent Runtime 工具调用统计 */
export const agentToolCallsTotal = new Counter({
  name: "agent_tool_calls_total",
  help: "Agent Runtime tool execution count",
  labelNames: ["tool_name", "status", "route"],
  registers: [registry],
});

/** Agent Runtime 记忆记录失败次数（fire-and-forget 路径异常） */
export const agentMemoryRecordFailures = new Counter({
  name: "agent_memory_record_failures_total",
  help: "Total number of failed async memory recordings",
  labelNames: ["reason"],
  registers: [registry],
});

/** Agent Runtime 各路由 Agent 调用统计 */
export const agentRouteInvocations = new Counter({
  name: "agent_route_invocations_total",
  help: "Agent Runtime route agent invocation count",
  labelNames: ["route", "status"], // status = success | error
  registers: [registry],
});

/** Agent Runtime 请求端到端延迟 */
export const agentRequestDurationMs = new Histogram({
  name: "agent_request_duration_ms",
  help: "Agent Runtime end-to-end request latency (TTFT and TTLT)",
  labelNames: ["route", "phase"],
  buckets: [
    5, 10, 25, 50, 100, 200, 300, 500, 800, 1000, 2500, 5000, 10000, 15000,
    30000,
  ],
  registers: [registry],
});

// V9 Multi-Agent Metrics
export const teamRunsTotal = new Counter({
  name: "team_runs_total",
  help: "Total number of team runs",
  labelNames: ["mode", "status"] as const,
  registers: [registry],
});

export const teamRoundsTotal = new Counter({
  name: "team_rounds_total",
  help: "Total team execution rounds",
  labelNames: ["mode"] as const,
  registers: [registry],
});

export const teamMessagesTotal = new Counter({
  name: "team_messages_total",
  help: "Total messages exchanged between agents",
  labelNames: ["type"] as const,
  registers: [registry],
});

export const teamAgentDurationMs = new Histogram({
  name: "team_agent_duration_ms",
  help: "Duration of individual agent execution within a team run",
  labelNames: ["role"] as const,
  buckets: [1000, 5000, 15000, 30000, 60000, 120000],
  registers: [registry],
});

export const teamBlackboardWritesTotal = new Counter({
  name: "team_blackboard_writes_total",
  help: "Total blackboard write operations",
  labelNames: ["key"] as const,
  registers: [registry],
});

// ---- Endpoint Registration ----

/** Register GET /api/metrics endpoint on the Hono app (before auth middleware) */
export function registerMetricsEndpoint(app: Hono<any>): void {
  app.get("/api/metrics", async (c) => {
    const metrics = await registry.metrics();
    return c.text(metrics, 200, {
      "Content-Type": registry.contentType,
    });
  });
}

// Export registry for testing
export { registry };
