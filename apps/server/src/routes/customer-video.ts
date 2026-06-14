// Customer video routes — public-facing endpoints (non-WebSocket only).
// The actual WebSocket upgrade is handled at the HTTP server level in index.ts
// (server.on('upgrade')) to avoid the double-write problem where Hono tries to
// send a second HTTP response over an already-upgraded WebSocket connection.
//
// This route serves as a fallback for plain HTTP requests (returns 426).
import { createHono } from "../lib/hono.js";

export const customerVideoRoutes = createHono();

// GET /api/customer-chat/video/stream — non-WebSocket fallback
customerVideoRoutes.get("/api/customer-chat/video/stream", (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) {
    return c.json({ detail: "session_id is required" }, 400);
  }

  // WebSocket upgrades are handled by the server; this is just HTTP
  const upgrade = c.req.header("upgrade");
  if (upgrade?.toLowerCase() === "websocket") {
    // Should not reach here — server-level upgrade handler intercepts first.
    // If we get here, something went wrong.
    return c.json({ detail: "WebSocket upgrade already handled" }, 500);
  }

  return c.json({ detail: "WebSocket upgrade required" }, 426);
});
