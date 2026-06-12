// HTTP metrics middleware — records request count and duration for Prometheus
// Registered FIRST in the middleware chain to capture all requests
// Path normalization prevents label cardinality explosion from UUIDs / IDs
import type { MiddlewareHandler } from "hono";
import { httpRequestsTotal, httpRequestDurationMs } from "../observability/metrics.js";

// Match UUIDs (36-char hex with dashes) and numeric/string IDs in path segments
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d+$/;

/** Normalize a URL path by replacing ID segments with :id placeholders */
function normalizePath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (ID_PATTERN.test(segment) || NUMERIC_ID.test(segment)) {
        return ":id";
      }
      return segment;
    })
    .join("/");
}

export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;

  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  const normalizedPath = normalizePath(path);
  const status = c.res.status.toString();

  httpRequestsTotal.inc({ method, path: normalizedPath, status });
  httpRequestDurationMs.observe({ method, path: normalizedPath }, duration);
};
