// 记忆管理路由 —— /api/memories
// 长期记忆系统已移除，所有端点返回空结果
import { createHono } from "../../../lib/hono.js";

export const memoryManagementRoutes = createHono();

// GET /api/memories —— 长期记忆已禁用，返回空列表
memoryManagementRoutes.get("/api/memories", async (c) => {
  const user = c.get("user");
  if (!user?.id) {
    return c.json({ detail: "未认证" }, 401);
  }
  return c.json({ memories: [], message: "长期记忆系统已禁用" });
});

// GET /api/memories/search?q=...&top_k=5 —— 长期记忆搜索已禁用
memoryManagementRoutes.get("/api/memories/search", async (c) => {
  const user = c.get("user");
  if (!user?.id) {
    return c.json({ detail: "未认证" }, 401);
  }
  return c.json({ results: [], message: "长期记忆搜索已禁用" });
});

// DELETE /api/memories/:id —— 长期记忆已禁用
memoryManagementRoutes.delete("/api/memories/:id", async (c) => {
  return c.json({ detail: "长期记忆系统已禁用" }, 404);
});
