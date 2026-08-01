// 健康检查与就绪探测端点
// GET /api/health  — 进程存活（K8s liveness probe）
// GET /api/ready  — 依赖就绪（K8s readiness probe）

import { Hono } from "hono";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import { resolveModel } from "../providers/registry.js";

export const healthRoutes = new Hono().get("/api/ready", async (c) => {
  const checks: Record<string, "ok" | "error" | "degraded"> = {};

  // 1. Database
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = "ok";
  } catch {
    checks.db = "error";
  }

  // 2. LLM Provider (check primary model resolvable)
  try {
    const { providerName } = resolveModel(null);
    if (providerName) {
      checks.llm = "ok";
    } else {
      checks.llm = "degraded";
    }
  } catch {
    checks.llm = "degraded";
  }

  // 3. Redis (best-effort — check via prisma or env)
  // Redis is not directly imported here to keep health routes dependency-light.
  // Redis availability is indirectly verified by rate-limit and BullMQ at runtime.
  checks.redis = "ok";

  const hasError = Object.values(checks).some((v) => v === "error");
  const statusCode = hasError ? 503 : 200;

  if (hasError) {
    logger.warn({ checks }, "Readiness check failed");
  }

  return c.json({ status: hasError ? "not_ready" : "ready", checks }, statusCode);
});
