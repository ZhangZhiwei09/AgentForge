// Request ID middleware — generates or forwards a correlation ID for each request
// All logger calls within the request lifecycle automatically include this ID
import { randomUUID } from "crypto";
import type { MiddlewareHandler } from "hono";
import { runWithRequestContext } from "@agentforge/logger";
import { logger } from "@agentforge/logger";
import type { AppVariables } from "../app.js";

export const requestIdMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  const requestId = c.req.header("X-Request-ID") || randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-ID", requestId);

  const method = c.req.method;
  const path = c.req.path;
  const start = Date.now();

  await runWithRequestContext({ requestId }, async () => {
    logger.info({ method, path }, "--> request");
    await next();
    const duration = Date.now() - start;
    logger.info({ method, path, status: c.res.status, durationMs: duration }, "<-- response");
  });
};
