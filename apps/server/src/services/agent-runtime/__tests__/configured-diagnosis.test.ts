import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configuredDiagnosis, hasConfiguredDiagnosis, hasWaitingConfiguredDiagnosis } from "../configured-diagnosis.js";
import { DiagnosisRouteAgent } from "../diagnosis-agent.js";
import type { RouteContext, RouteStreamEvent } from "../types.js";
import type { ExecutionScope } from "../../../runtime/scope.js";

const { query, instantiate } = vi.hoisted(() => ({
  query: vi.fn(), instantiate: vi.fn(),
}));
vi.mock("../../../db.js", () => ({ prisma: { $queryRaw: query } }));
vi.mock("../../../teams/service.js", () => ({ teamService: { instantiate } }));
vi.mock("@agentforge/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../../observability/metrics.js", () => ({
  agentRouteInvocations: { inc: vi.fn() },
}));

const context: RouteContext = {
  conversationId: "conversation-1", sessionId: null, userMessage: "traceId: 123 ACE_TIMEOUT",
  history: [], knowledgeContext: "", knowledgeResults: [], kbChunks: [],
  memoryContext: "", injectedMemories: ["one"], resolvedModel: "deepseek-chat",
  providerName: "deepseek", withinServiceHours: true, assistantMsgId: "assistant-1", intent: "diagnosis",
};

async function collect(stream: AsyncGenerator<RouteStreamEvent>) {
  const events: RouteStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function responseFor(events: unknown[], byteChunks = false) {
  const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({
    start(controller) {
      if (byteChunks) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

describe("configured diagnosis bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("JWT_SECRET", "test-bridge-secret");
    vi.stubEnv("AGENT_FLOW_BACKEND_URL", "http://flow-backend.test");
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("signs the exact body and parses split UTF-8 and CRLF frames", async () => {
    const fetcher = vi.fn().mockResolvedValue(responseFor([
      { type: "token", content: "诊断结果", message_id: "assistant-1" },
      { type: "done", message_id: "assistant-1", usage: {}, route: "DIAGNOSIS" },
    ], true));
    vi.stubGlobal("fetch", fetcher);
    const events = await collect(configuredDiagnosis(context));
    expect(events[0]).toMatchObject({ type: "token", content: "诊断结果" });
    expect(events[1]).toMatchObject({ type: "done", memory: { injected: 1, extracted: 0 } });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("http://flow-backend.test/api/agent-flows/runtime/diagnose");
    const headers = options.headers;
    const expected = createHmac("sha256", "test-bridge-secret")
      .update(`${headers["X-Agent-Flow-Timestamp"]}\n/api/agent-flows/runtime/diagnose\n${options.body}`)
      .digest("hex");
    expect(headers["X-Agent-Flow-Signature"]).toBe(expected);
    expect(JSON.parse(options.body)).not.toHaveProperty("actorId");
  });

  it("passes the execution cancellation signal", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn().mockResolvedValue(responseFor([{ type: "done", usage: {} }]));
    vi.stubGlobal("fetch", fetcher);
    await collect(configuredDiagnosis(context, { context: { signal: abort.signal } } as ExecutionScope));
    expect(fetcher.mock.calls[0][1].signal).toBe(abort.signal);
  });

  it("rejects exposed internal node debug events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor([
      { type: "node_completed", inputs: { secret: "not-public" } },
    ])));
    await expect(collect(configuredDiagnosis(context))).rejects.toThrow("Unexpected");
  });

  it("reports a truncated stream as failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(responseFor([{ type: "token", content: "partial" }])));
    await expect(collect(configuredDiagnosis(context))).rejects.toThrow("before completion");
  });

  it("does not rerun the legacy team when the configured backend fails", async () => {
    query.mockResolvedValue([{ active: true }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    const events = await collect(new DiagnosisRouteAgent().execute(context));
    expect(events.map((event) => event.type)).toEqual(["meta", "error", "done"]);
    expect(instantiate).not.toHaveBeenCalled();
  });

  it("checks enabled flows and pending conversation runs", async () => {
    query.mockResolvedValueOnce([{ active: true }]).mockResolvedValueOnce([{ active: true }]);
    expect(await hasConfiguredDiagnosis("conversation-1")).toBe(true);
    expect(await hasWaitingConfiguredDiagnosis("conversation-1")).toBe(true);
    expect(query.mock.calls[0][1]).toBe("conversation-1");
  });
});
