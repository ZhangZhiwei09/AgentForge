// 工具查询路由 —— 前端可以查询可用的工具列表（含风险等级等元数据）
import { toolRegistry } from "../tools/registry.js";
import { createHono } from "../lib/hono.js";

export const toolRoutes = createHono();

// GET /api/tools —— 列出所有已注册的工具定义（包含风险等级和类别）
toolRoutes.get("/api/tools", (c) => {
  const tools = toolRegistry.getAll().map((t) => ({
    name: t.definition.function.name,
    description: t.definition.function.description,
    parameters: t.definition.function.parameters,
    risk_level: t.riskLevel,
    timeout_ms: t.timeout,
    require_approval: t.requireApproval,
    category: t.category,
    sandbox: t.sandbox || false,
    parallelizable: t.parallelizable,
  }));

  const circuitBreakers = toolRegistry.getCircuitBreakerStates();
  const openCircuits = Object.entries(circuitBreakers)
    .filter(([, state]) => state.open)
    .map(([name]) => name);

  return c.json({
    tools,
    count: tools.length,
    circuit_breakers_open: openCircuits.length > 0 ? openCircuits : undefined,
  });
});
