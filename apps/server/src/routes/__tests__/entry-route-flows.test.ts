import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHono } from "../../lib/hono.js";
import { authMiddleware } from "../../middleware/auth.js";
import { entryRouteFlowRoutes } from "../entry-route-flows.js";
import { EntryFlowError } from "../../services/entry-route-flows/schema.js";

const { service, validateToken } = vi.hoisted(() => ({
  service: Object.fromEntries(["list", "create", "get", "save", "validate", "publish", "activate", "archive", "testRun", "runs", "getRun"].map((name) => [name, vi.fn()])),
  validateToken: vi.fn(),
}));
vi.mock("../../services/entry-route-flows/service.js", () => ({ entryRouteFlowService: service }));
vi.mock("../../services/auth.js", () => ({ authService: { validateToken } }));
const app = createHono();
app.use("*", authMiddleware);
app.route("/", entryRouteFlowRoutes);
const flowId = "a348c004-f05f-4d1a-8b6f-34f880b306a8";
const runId = "80209f39-2ad0-4724-8898-7f61a2c222bb";
const paths: Array<[string, string, unknown]> = [
  ["GET", "", undefined], ["POST", "", { name: "flow" }], ["GET", `/${flowId}`, undefined],
  ["PUT", `/${flowId}/draft`, { name: "flow", revision: 1, definition: {} }],
  ["POST", `/${flowId}/validate`, { revision: 1 }], ["POST", `/${flowId}/publish`, { revision: 1 }],
  ["POST", `/${flowId}/test-run`, { revision: 1, message: "hello" }],
  ["PUT", `/${flowId}/activation`, { enabled: true }], ["DELETE", `/${flowId}`, undefined],
  ["GET", `/${flowId}/runs`, undefined], ["GET", `/${flowId}/runs/${runId}`, undefined],
];
function request(method: string, path: string, data?: unknown, token?: string) {
  return app.request(`/api/entry-route-flows${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  validateToken.mockImplementation(async (token: string) => token === "admin" ? { id: "admin-id", role: "admin" } : token === "user" ? { id: "user-id", role: "user" } : null);
  for (const value of Object.values(service)) value.mockResolvedValue({ ok: true });
});
describe("entry management authorization", () => {
  it.each(paths)("requires authentication on %s %s", async (method, path, data) => {
    expect((await request(method, path, data)).status).toBe(401);
    expect((await request(method, path, data, "invalid")).status).toBe(401);
    for (const value of Object.values(service)) expect(value).not.toHaveBeenCalled();
  });
  it.each(paths)("requires admin on %s %s", async (method, path, data) => {
    expect((await request(method, path, data, "user")).status).toBe(403);
    for (const value of Object.values(service)) expect(value).not.toHaveBeenCalled();
  });
  it.each(paths)("accepts admin on %s %s", async (method, path, data) => {
    const response = await request(method, path, data, "admin");
    expect(response.status).toBe(method === "POST" && path === "" ? 201 : 200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("uses verified actor identity and rejects route overrides", async () => {
    await request("POST", "", { name: " flow ", template: "empty" }, "admin");
    expect(service.create).toHaveBeenCalledWith("flow", "admin-id", "empty");
    const denied = await request("POST", `/${flowId}/test-run`, { revision: 1, message: "hi", route: "HUMAN" }, "admin");
    expect(denied.status).toBe(400);
    expect(service.testRun).not.toHaveBeenCalled();
  });
  it("returns 409 for stale revisions without invalidating login", async () => {
    service.publish.mockRejectedValue(new EntryFlowError("stale", 409));
    expect((await request("POST", `/${flowId}/publish`, { revision: 1 }, "admin")).status).toBe(409);
  });
  it("returns controlled errors for infrastructure failures", async () => {
    service.list.mockRejectedValue(new Error("password=secret"));
    const response = await request("GET", "", undefined, "admin");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
  });
  it.each([
    ["POST", `/${flowId}/publish`, { revision: 0 }],
    ["PUT", `/${flowId}/activation`, { enabled: "true" }],
    ["POST", `/${flowId}/test-run`, { revision: 1, message: " " }],
    ["POST", `/${flowId}/test-run`, { revision: 1, message: "x".repeat(16001) }],
    ["GET", `/${flowId}/runs?pageSize=999`, undefined],
    ["GET", "/invalid-id", undefined],
    ["GET", `/${flowId}/runs/not-a-uuid`, undefined],
  ])("validates %s %s", async (method, path, data) => {
    expect((await request(method as string, path as string, data, "admin")).status).toBe(400);
  });
  it("rejects malformed JSON", async () => {
    const response = await app.request("/api/entry-route-flows", { method: "POST", headers: { Authorization: "Bearer admin" }, body: "{" });
    expect(response.status).toBe(400);
  });
});
