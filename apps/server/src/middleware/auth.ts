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
  "/api/agent/chat", // Anonymous agent SSE chat
  "/api/diagnosis/query", // Anonymous diagnosis demo endpoint
  "/api/agent/chat/history", // Load session history
  "/api/agent/chat/conversations", // List conversations (auth-aware internally)
  "/api/agent/chat/rate", // Submit satisfaction rating
  "/debug/diagnosis", // Debug: DiagnosisMode visual verification page
];

// Prefix-based public paths (any path starting with these is public)
// NOTE: Only FAQ sub-tree is public via prefix — feedback/analytics are protected by auth
const PUBLIC_PREFIXES = [
  "/api/agent/chat/faq", // Anonymous FAQ browsing
  "/api/agent/chat/conversations/", // Delete conversation (has internal auth)
];

export const authMiddleware: MiddlewareHandler<{
  Variables: AppVariables;
}> = async (c, next) => {
  // Skip auth for public routes (exact match)
  if (PUBLIC_PATHS.some((p) => c.req.path === p)) {
    return next();
  }

  // Skip auth for public prefixes (starts with)
  if (PUBLIC_PREFIXES.some((prefix) => c.req.path.startsWith(prefix))) {
    return next();
  }

  const token =
    c.req.header("Authorization")?.replace("Bearer ", "") ??
    c.req.query("api_key");

  if (!token) {
    return c.json({ detail: "Unauthorized — missing token" }, 401);
  }

  const user = await authService.validateToken(token);
  if (!user) {
    return c.json({ detail: "Invalid or expired token" }, 401);
  }

  // Inject user into context for downstream handlers
  c.set("user", user);
  c.set("requestId", c.get("requestId") || ""); // Ensure requestId from earlier middleware

  logger.debug({ userId: user.id, path: c.req.path }, "Auth OK");
  await next();
};
