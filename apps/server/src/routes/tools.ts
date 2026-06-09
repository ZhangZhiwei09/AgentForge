// 工具查询路由 —— 前端可以查询可用的工具列表
import { Hono } from "hono";
import { toolRegistry } from "../tools/registry.js";

export const toolRoutes = new Hono();

// GET /api/tools —— 列出所有已注册的工具定义
toolRoutes.get("/api/tools", (c) => {
  const tools = toolRegistry.getAll().map((t) => ({
    name: t.definition.function.name,
    description: t.definition.function.description,
    parameters: t.definition.function.parameters,
  }));
  return c.json({ tools, count: tools.length });
});
