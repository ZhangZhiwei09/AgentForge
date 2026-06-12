// Auth middleware — validates JWT/API key and injects user into Hono context
import type { MiddlewareHandler } from "hono";
import { authService } from "../services/auth.js";
import { logger } from "@agentforge/logger";
import type { AppVariables } from "../app.js";

// Public routes that don't require authentication
const PUBLIC_PATHS = [
  "/api/auth/signup",
  "/api/auth/signin",
  "/api/auth/refresh",
  "/api/health",
];

// Prefix-based public paths (any path starting with these is public)
const PUBLIC_PREFIXES = [
  "/api/customer-chat",  // Anonymous customer chat + FAQ + rate + analytics
];

export const authMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  // Skip auth for public routes (exact match)
  if (PUBLIC_PATHS.some((p) => c.req.path === p)) {
    return next();
  }

  // Skip auth for public prefixes (starts with)
  if (PUBLIC_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) {
    return next();
  }

  const token = c.req.header("Authorization")?.replace("Bearer ", "")
    ?? c.req.query("api_key");

  if (!token) {
    return c.json({ detail: "Unauthorized — missing token" }, 401);
  }

  const user = await authService.validateToken(token);
  if (!user) {
    return c.json({ detail: "Invalid or expired token" }, 401);
  }

  // Inject user into context for downstream handlers
  c.set("user", user);
  c.set("requestId", c.get("requestId") || "");  // Ensure requestId from earlier middleware

  logger.debug({ userId: user.id, path: c.req.path }, "Auth OK");
  await next();
}
