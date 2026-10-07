// Keep the public API on the existing server; Python owns flow execution.
import { createHono } from "../lib/hono.js";
import type { Context } from "hono";
import type { AppVariables } from "../app.js";

export const agentFlowRoutes = createHono();

agentFlowRoutes.all("/api/agent-flows/*", forward);
agentFlowRoutes.all("/api/agent-flows", forward);

async function forward(c: Context<{ Variables: AppVariables }>) {
  if (c.get("user").role !== "admin") {
    return c.json({ detail: "仅管理员可以管理 Agent 流程" }, 403);
  }
  // Internal runtime endpoints require their own signed server-to-server request.
  if (c.req.path.startsWith("/api/agent-flows/runtime/")) {
    return c.json({ detail: "Not found" }, 404);
  }
  const base = process.env.AGENT_FLOW_BACKEND_URL || "http://127.0.0.1:8004";
  try {
    const url = new URL(c.req.raw.url);
    const response = await fetch(`${base}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers: {
        Authorization: c.req.header("Authorization") || "",
        "Content-Type": "application/json",
      },
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.text(),
      signal: c.req.raw.signal,
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return c.json({ detail: "流程后端不可用，请检查 AGENT_FLOW_BACKEND_URL" }, 502);
  }
}
