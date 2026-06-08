// 记忆管理路由 —— /api/memories 查询、搜索、删除
import { Hono } from "hono";
import { MemoryEngine } from "../services/memory-engine.js";

export const memoryRoutes = new Hono();

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

// GET /api/memories —— 列出所有记忆（可选 type 过滤：semantic/preference/episodic）
memoryRoutes.get("/api/memories", async (c) => {
  const type = c.req.query("type") || undefined;
  const engine = new MemoryEngine();
  const memories = await engine.list(DEFAULT_USER_ID, type);
  return c.json(memories);
});

// GET /api/memories/search?q=...&top_k=5 —— 语义搜索记忆
memoryRoutes.get("/api/memories/search", async (c) => {
  const q = c.req.query("q");
  if (!q) {
    return c.json({ detail: "Missing query parameter 'q'" }, 400);
  }
  const topK = parseInt(c.req.query("top_k") || "5", 10);

  const engine = new MemoryEngine();
  const results = await engine.search(q, DEFAULT_USER_ID, topK);
  return c.json(results);
});

// DELETE /api/memories/:id —— 删除单条记忆（PG + Milvus 双删）
memoryRoutes.delete("/api/memories/:id", async (c) => {
  const id = c.req.param("id");
  const engine = new MemoryEngine();
  const deleted = await engine.delete(id);

  if (!deleted) {
    return c.json({ detail: "Memory not found" }, 404);
  }

  return c.json({ status: "deleted" });
});
