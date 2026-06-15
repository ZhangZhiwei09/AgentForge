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

// ---- Chat / LLM Metrics ----

export const chatMessagesTotal = new Counter({
  name: "chat_messages_total",
  help: "Total number of chat completions",
  labelNames: ["provider", "model"],
  registers: [registry],
});

export const chatTokensTotal = new Counter({
  name: "chat_tokens_total",
  help: "Total LLM tokens consumed",
  labelNames: ["provider", "type"], // type = prompt | completion
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

// ---- Memory Metrics ----

export const memoryExtractionsTotal = new Counter({
  name: "memory_extractions_total",
  help: "Total number of memory extractions performed",
  labelNames: [] as const,
  registers: [registry],
});

// ---- Milvus / Vector Search Metrics ----

export const milvusSearchDurationMs = new Histogram({
  name: "milvus_search_duration_ms",
  help: "Milvus vector search duration in milliseconds",
  labelNames: ["operation"], // operation = memory | knowledge
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [registry],
});

// ---- Voice Metrics ----

export const voiceSessionsTotal = new Counter({
  name: "voice_sessions_total",
  help: "Total number of voice sessions created",
  labelNames: ["status"],
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

// ---- Customer Chat Metrics ----

/** 客服消息路由分类统计（按路由和分类来源） */
export const csRouteClassificationTotal = new Counter({
  name: "cs_route_classification_total",
  help: "Customer chat route classification count by route and source",
  labelNames: ["route", "source"], // route = SAFETY | SMALL_TALK | TOOL | HUMAN; source = keyword | llm | fallback
  registers: [registry],
});

/** 客服路由分类置信度分布 */
export const csRouteConfidence = new Histogram({
  name: "cs_route_confidence",
  help: "Customer chat route classification confidence distribution",
  labelNames: ["route"],
  buckets: [0.1, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95, 1.0],
  registers: [registry],
});

/** 客服 Agent ReAct 循环迭代次数分布 */
export const csReActIterations = new Histogram({
  name: "cs_react_iterations",
  help: "Customer chat Agent ReAct loop iteration count",
  labelNames: ["agent_type"], // agent_type = tool_agent
  buckets: [1, 2, 3, 4, 5, 7, 10],
  registers: [registry],
});

/** 客服回复引证覆盖率（Citation Coverage） */
export const csCitationCoverage = new Histogram({
  name: "cs_citation_coverage",
  help: "Customer chat response citation coverage rate",
  labelNames: ["level"], // level = embedding | keyword_fallback
  buckets: [0, 0.25, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
  registers: [registry],
});

/** 客服场景工具调用统计 */
export const csToolCallsTotal = new Counter({
  name: "cs_tool_calls_total",
  help: "Customer chat tool execution count",
  labelNames: ["tool_name", "status", "route"], // route = TOOL
  registers: [registry],
});

/** 客服请求端到端延迟（TTFT = 首token时间, TTLT = 末token时间） */
export const csRequestDurationMs = new Histogram({
  name: "cs_request_duration_ms",
  help: "Customer chat end-to-end request latency (TTFT and TTLT)",
  labelNames: ["route", "phase"], // phase = ttft | ttlt
  buckets: [5, 10, 25, 50, 100, 200, 300, 500, 800, 1000, 2500, 5000, 10000, 15000, 30000],
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
