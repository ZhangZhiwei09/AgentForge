// Provider 查询路由 —— 前端切换模型时需要知道有哪些可用厂商和模型
import { Hono } from "hono";
import { listProviders } from "../providers/registry.js";

export const providerRoutes = new Hono();

// GET /api/providers —— 列出所有已配置的 LLM Provider 及其模型
providerRoutes.get("/api/providers", (c) => {
  return c.json(listProviders());
});
