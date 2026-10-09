import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { AppVariables } from "../../app.js";
import { authMiddleware } from "../../middleware/auth.js";
import { agentFlowRoutes } from "../agent-flows.js";

const { validateToken } = vi.hoisted(() => ({ validateToken: vi.fn() }));
vi.mock("../../services/auth.js", () => ({ authService: { validateToken } }));
vi.mock("@agentforge/logger", () => ({ logger: { debug: vi.fn() } }));

const admin = { id: "platform-admin", email: "admin@example.test", role: "admin" };

function app() {
  const server = new Hono<{ Variables: AppVariables }>();
  server.use("*", authMiddleware);
  server.route("/", agentFlowRoutes);
  return server;
}

describe("agent flow proxy authentication", () => {
  const upstream = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", upstream);
    validateToken.mockResolvedValue(admin);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps genuine public-server authentication failures as 401", async () => {
    validateToken.mockResolvedValue(null);
    const response = await app().request("/api/agent-flows", {
      headers: { Authorization: "Bearer invalid" },
    });
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not forward unauthenticated or non-admin requests", async () => {
    expect((await app().request("/api/agent-flows")).status).toBe(401);
    validateToken.mockResolvedValue({ ...admin, role: "user" });
    const response = await app().request("/api/agent-flows", {
      headers: { Authorization: "Bearer user-token" },
    });
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("reports upstream user/token rejection without invalidating a valid session", async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify({ detail: "User not found" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    }));
    const response = await app().request("/api/agent-flows", {
      headers: { Authorization: "Bearer admin-token" },
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      detail: expect.stringContaining("JWT_SECRET"),
    });
    expect(upstream).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer admin-token" }),
    }));
  });

  it("forwards successful responses and real permission errors unchanged", async () => {
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ items: [] }), {
      headers: { "Content-Type": "application/json" },
    }));
    const server = app();
    const response = await server.request("/api/agent-flows", {
      headers: { Authorization: "Bearer admin-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    upstream.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Admin required" }), {
      status: 403, headers: { "Content-Type": "application/json" },
    }));
    expect((await server.request("/api/agent-flows", {
      headers: { Authorization: "Bearer admin-token" },
    })).status).toBe(403);
  });

  it("never exposes internal signed runtime endpoints", async () => {
    const response = await app().request("/api/agent-flows/runtime/diagnose", {
      method: "POST", headers: { Authorization: "Bearer admin-token" },
    });
    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
