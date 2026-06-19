// 记忆管理路由 —— /api/memories 查询、搜索、删除
import { MemoryEngine } from "../../../services/memory-engine.js";
import { createHono } from "../../../lib/hono.js";

export const memoryManagementRoutes = createHono();

// GET /api/memories —— 列出所有记忆（可选 type 过滤：semantic/preference/episodic）
memoryManagementRoutes.get("/api/memories", async (c) => {
  const user = c.get("user");
  const type = c.req.query("type") || undefined;
  const engine = new MemoryEngine();
  const memories = await engine.list(user.id, type);
  return c.json(memories);
});

// GET /api/memories/search?q=...&top_k=5 —— 语义搜索记忆
memoryManagementRoutes.get("/api/memories/search", async (c) => {
  const user = c.get("user");
  const q = c.req.query("q");
  if (!q) {
    return c.json({ detail: "Missing query parameter 'q'" }, 400);
  }
  const topK = parseInt(c.req.query("top_k") || "5", 10);

  const engine = new MemoryEngine();
  const results = await engine.search(q, user.id, topK);
  return c.json(results);
});

// DELETE /api/memories/:id —— 删除单条记忆（PG + Milvus 双删）
memoryManagementRoutes.delete("/api/memories/:id", async (c) => {
  const id = c.req.param("id");
  const engine = new MemoryEngine();
  const deleted = await engine.delete(id);

  if (!deleted) {
    return c.json({ detail: "Memory not found" }, 404);
  }

  return c.json({ status: "deleted" });
});
