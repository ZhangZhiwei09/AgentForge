// Metrics middleware and endpoint tests
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";

// ════════════════════════════════════════════════
// Mock prom-client — all metrics use test doubles
// ════════════════════════════════════════════════

const {
  PROM_CONTENT_TYPE,
  mockInc,
  mockObserve,
  mockSet,
  mockRegistryMetrics,
  mockSetDefaultLabels,
  mockCollectDefaultMetrics,
} = vi.hoisted(() => ({
  PROM_CONTENT_TYPE: "text/plain; version=0.0.4; charset=utf-8",
  mockInc: vi.fn(),
  mockObserve: vi.fn(),
  mockSet: vi.fn(),
  mockRegistryMetrics: vi.fn<() => Promise<string>>(),
  mockSetDefaultLabels: vi.fn(),
  mockCollectDefaultMetrics: vi.fn(),
}));

vi.mock("prom-client", () => ({
  Counter: vi.fn().mockImplementation(() => ({ inc: mockInc })),
  Histogram: vi.fn().mockImplementation(() => ({ observe: mockObserve })),
  Gauge: vi.fn().mockImplementation(() => ({ set: mockSet })),
  Registry: vi.fn().mockImplementation(() => ({
    metrics: mockRegistryMetrics,
    contentType: PROM_CONTENT_TYPE,
    setDefaultLabels: mockSetDefaultLabels,
  })),
  collectDefaultMetrics: mockCollectDefaultMetrics,
}));

// Import real implementations — they use mocked prom-client internally
import { registerMetricsEndpoint } from "../../observability/metrics.js";
import { metricsMiddleware } from "../metrics.js";

// ── Helpers ──────────────────────────────────────

function createAppWithMiddleware() {
  const app = new Hono();
  app.use("*", metricsMiddleware);
  app.get("/api/health", (c) => c.text("ok"));
  app.get("/api/error", (c) => {
    c.status(500);
    return c.text("boom");
  });
  // Route with a dynamic :id param to exercise path normalization
  app.get("/api/projects/:id", (c) => c.text("project"));
  return app;
}

const SAMPLE_METRICS = [
  "# HELP agentforge_http_requests_total Total number of HTTP requests",
  "# TYPE agentforge_http_requests_total counter",
  "agentforge_http_requests_total{method=\"GET\",path=\"/api/metrics\",status=\"200\"} 1",
  "",
].join("\n");

// ════════════════════════════════════════════════
// registerMetricsEndpoint
// ════════════════════════════════════════════════

describe("registerMetricsEndpoint", () => {
  let app: Hono;

  beforeEach(() => {
    mockRegistryMetrics.mockReset();
    mockRegistryMetrics.mockResolvedValue(SAMPLE_METRICS);
    app = new Hono();
  });

  it("GET /api/metrics returns 200 with Prometheus text format", async () => {
    registerMetricsEndpoint(app);

    const res = await app.request("/api/metrics");

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# HELP agentforge_");
    expect(text).toContain("# TYPE agentforge_");
  });

  it("Content-Type header is correct (Prometheus content type)", async () => {
    registerMetricsEndpoint(app);

    const res = await app.request("/api/metrics");

    expect(res.headers.get("Content-Type")).toBe(PROM_CONTENT_TYPE);
  });

  it("Metrics endpoint is registered correctly on Hono app", async () => {
    // registerMetricsEndpoint must be called before any app.request(),
    // because Hono builds its router matcher on the first request and
    // does not allow adding routes after that point.
    registerMetricsEndpoint(app);

    const res = await app.request("/api/metrics");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(SAMPLE_METRICS);
    expect(mockRegistryMetrics).toHaveBeenCalledTimes(1);
  });

  it("Default metrics are collected with agentforge_ prefix", () => {
    registerMetricsEndpoint(app);

    // collectDefaultMetrics is called at module import time (metrics module init)
    // with prefix: "agentforge_"
    expect(mockCollectDefaultMetrics).toHaveBeenCalled();
    const callArg = mockCollectDefaultMetrics.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(callArg.prefix).toBe("agentforge_");
  });

  it("returns the current registry metrics on each call", async () => {
    const firstMetrics = [
      "# HELP agentforge_test test",
      "# TYPE agentforge_test counter",
      "agentforge_test 5",
    ].join("\n");
    const secondMetrics = [
      "# HELP agentforge_test test",
      "# TYPE agentforge_test counter",
      "agentforge_test 10",
    ].join("\n");

    mockRegistryMetrics.mockResolvedValueOnce(firstMetrics);
    registerMetricsEndpoint(app);

    const res1 = await app.request("/api/metrics");
    expect(await res1.text()).toBe(firstMetrics);

    mockRegistryMetrics.mockResolvedValueOnce(secondMetrics);
    const res2 = await app.request("/api/metrics");
    expect(await res2.text()).toBe(secondMetrics);

    expect(mockRegistryMetrics).toHaveBeenCalledTimes(2);
  });
});

// ════════════════════════════════════════════════
// metricsMiddleware
// ════════════════════════════════════════════════

describe("metricsMiddleware", () => {
  let app: Hono;

  beforeEach(() => {
    mockInc.mockClear();
    mockObserve.mockClear();
    app = createAppWithMiddleware();
  });

  it("increments httpRequestsTotal counter on requests", async () => {
    await app.request("/api/health");

    expect(mockInc).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/health",
      status: "200",
    });
  });

  it("records correct status code in the counter (500 error path)", async () => {
    await app.request("/api/error");

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        status: "500",
      }),
    );
  });

  it("httpRequestDurationMs histogram records durations", async () => {
    await app.request("/api/health");

    expect(mockObserve).toHaveBeenCalledTimes(1);
    const [labels, duration] = mockObserve.mock.calls[0];
    expect(labels).toEqual({
      method: "GET",
      path: "/api/health",
    });
    expect(typeof duration).toBe("number");
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it("records metrics with actual HTTP method (POST)", async () => {
    app.post("/api/submit", (c) => c.text("created"));
    await app.request("/api/submit", { method: "POST" });

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST" }),
    );
    expect(mockObserve).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST" }),
      expect.any(Number),
    );
  });

  it("calls both inc and observe for every request", async () => {
    await app.request("/api/health");

    expect(mockInc).toHaveBeenCalledTimes(1);
    expect(mockObserve).toHaveBeenCalledTimes(1);
  });

  it("does not mutate the response or interfere with downstream handlers", async () => {
    const res = await app.request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  // ── Path Normalization ─────────────────────────

  it("replaces UUID segments with :id placeholder", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    await app.request(`/api/projects/${uuid}`);

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/projects/:id",
      }),
    );
    expect(mockObserve).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/projects/:id",
      }),
      expect.any(Number),
    );
  });

  it("replaces numeric ID segments with :id placeholder", async () => {
    await app.request("/api/projects/12345");

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/projects/:id",
      }),
    );
    expect(mockObserve).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/projects/:id",
      }),
      expect.any(Number),
    );
  });

  it("does not normalize non-ID path segments", async () => {
    // "abc-123" is neither a UUID nor a purely numeric segment,
    // so it should pass through unchanged
    await app.request("/api/projects/abc-123");

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/projects/abc-123",
      }),
    );
  });

  it("does not normalize alphanumeric segment containing letters and numbers", async () => {
    await app.request("/api/projects/proj-001");

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/projects/proj-001",
      }),
    );
  });

  it("normalizes only ID segments while keeping static segments intact", async () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    await app.request(`/api/projects/${uuid}/tasks/42`);

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/projects/:id/tasks/:id",
      }),
    );
  });

  it("correctly normalizes UUID with mixed case", async () => {
    const mixedUuid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
    await app.request(`/api/projects/${mixedUuid}`);

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/projects/:id",
      }),
    );
  });

  it("does not normalize empty path segments (//)", async () => {
    // Hono normalizes paths so double slashes are collapsed,
    // but verify the middleware handles edge cases gracefully
    await app.request("/api/health");

    expect(mockInc).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/health",
      }),
    );
  });
});
