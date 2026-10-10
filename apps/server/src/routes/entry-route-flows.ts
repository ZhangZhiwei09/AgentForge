import { z } from "zod";
import { createHono } from "../lib/hono.js";
import { entryRouteFlowService as service } from "../services/entry-route-flows/service.js";
import { EntryFlowError, ENTRY_LIMITS } from "../services/entry-route-flows/schema.js";
import { logger } from "@agentforge/logger";

export const entryRouteFlowRoutes = createHono().basePath("/api/entry-route-flows");
entryRouteFlowRoutes.use("*", async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ detail: "请先登录" }, 401);
  if (user.role !== "admin") return c.json({ detail: "仅管理员可以管理一级路由流程" }, 403);
  c.header("Cache-Control", "no-store");
  await next();
});
entryRouteFlowRoutes.onError((error, c) => {
  if (error instanceof EntryFlowError) return c.json({
    detail: { message: error.message, errors: error.errors },
  }, error.status);
  logger.error({ path: c.req.path }, "Entry route flow API failed");
  return c.json({ detail: "一级流程服务暂不可用，请检查数据库与配置" }, 503);
});

const name = z.string().trim().min(1).max(200);
const revision = z.number().int().positive();
const revisionBody = z.object({ revision }).strict();
const id = z.string().uuid();
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new EntryFlowError("请求格式错误", 400,
    parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
  return parsed.data;
}
entryRouteFlowRoutes.use("/:id/*", async (c, next) => {
  checked(id, c.req.param("id"));
  await next();
});
entryRouteFlowRoutes.use("/:id", async (c, next) => {
  checked(id, c.req.param("id"));
  await next();
});

async function body(c: { req: { text(): Promise<string> } }): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.length > 300000) throw new EntryFlowError("请求内容超过上限", 400);
  try { return JSON.parse(raw); } catch { throw new EntryFlowError("请求必须是有效 JSON", 400); }
}

entryRouteFlowRoutes.get("/", async (c) => c.json(await service.list()));
entryRouteFlowRoutes.post("/", async (c) => {
  const input = checked(z.object({ name, template: z.enum(["default", "empty"]).default("default") }).strict(), await body(c));
  return c.json(await service.create(input.name, c.get("user").id, input.template), 201);
});
entryRouteFlowRoutes.get("/:id", async (c) => c.json(await service.get(c.req.param("id"))));
entryRouteFlowRoutes.put("/:id/draft", async (c) => {
  const input = checked(z.object({ name, revision, definition: z.unknown() }).strict(), await body(c));
  return c.json(await service.save(c.req.param("id"), input.name, input.revision, input.definition, c.get("user").id));
});
entryRouteFlowRoutes.post("/:id/validate", async (c) => {
  const input = checked(revisionBody, await body(c));
  return c.json(await service.validate(c.req.param("id"), input.revision));
});
entryRouteFlowRoutes.post("/:id/publish", async (c) => {
  const input = checked(revisionBody, await body(c));
  return c.json(await service.publish(c.req.param("id"), input.revision, c.get("user").id));
});
entryRouteFlowRoutes.put("/:id/activation", async (c) => {
  const input = checked(z.object({ enabled: z.boolean() }).strict(), await body(c));
  return c.json(await service.activate(c.req.param("id"), input.enabled, c.get("user").id));
});
entryRouteFlowRoutes.delete("/:id", async (c) => c.json(await service.archive(c.req.param("id"), c.get("user").id)));
entryRouteFlowRoutes.post("/:id/test-run", async (c) => {
  const input = checked(z.object({
    revision, message: z.string().min(1).max(ENTRY_LIMITS.messageLength).refine((s) => !!s.trim(), "消息不能为空"),
  }).strict(), await body(c));
  return c.json(await service.testRun(c.req.param("id"), input.revision, input.message, c.get("user").id, c.req.raw.signal));
});
entryRouteFlowRoutes.get("/:id/runs", async (c) => {
  const query = checked(z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  }).strict(), c.req.query());
  return c.json(await service.runs(c.req.param("id"), query.page, query.pageSize));
});
entryRouteFlowRoutes.get("/:id/runs/:runId", async (c) => {
  checked(id, c.req.param("runId"));
  return c.json(await service.getRun(c.req.param("id"), c.req.param("runId")));
});
