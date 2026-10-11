import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyBusinessIntent, BUSINESS_CLASSIFIER_PROMPT } from "../business-classifier.js";
import type { ObservabilityTrace } from "../../../../observability/provider.js";

const mocks = vi.hoisted(() => ({
  chat: vi.fn(), resolve: vi.fn(), get: vi.fn(), calls: vi.fn(), duration: vi.fn(), warn: vi.fn(),
}));
vi.mock("../../../../providers/registry.js", () => ({ resolveModel: mocks.resolve, getProvider: mocks.get }));
vi.mock("@agentforge/logger", () => ({ logger: { warn: mocks.warn } }));
vi.mock("../../../../observability/metrics.js", () => ({
  agentBusinessClassificationCallsTotal: { inc: mocks.calls },
  agentBusinessClassificationDurationMs: { observe: mocks.duration },
}));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockReturnValue({ providerName: "test", modelId: "test-model" });
  mocks.get.mockReturnValue({ chatSync: mocks.chat });
});
const response = (value: unknown) => ({
  content: JSON.stringify(value), usage: { prompt_tokens: 10, completion_tokens: 20 },
});
const valid = { intent: "consultation", resolvedQuery: "FACE_TIMEOUT 的含义", reasoning: "咨询知识" };

describe("one-call business classifier", () => {
  it.each(["consultation", "diagnosis", "unclear"])("validates %s with one provider call", async (intent) => {
    const result = { ...valid, intent, ...(intent === "unclear" ? { clarification: "想咨询还是排查？" } : {}) };
    mocks.chat.mockResolvedValue(response(result));
    expect(await classifyBusinessIntent("这个错误", [], "chosen-model")).toEqual({ status: "valid", result });
    expect(mocks.chat).toHaveBeenCalledExactlyOnceWith(
      [{ role: "user", content: "这个错误" }], "test-model", BUSINESS_CLASSIFIER_PROMPT, 0, 600, true,
    );
    expect(mocks.resolve).toHaveBeenCalledWith("chosen-model");
    expect(mocks.calls).toHaveBeenCalledWith({ outcome: intent === "unclear" ? "unclear" : "valid" });
  });
  it("uses only the last four user/assistant messages, preserving reference information", async () => {
    mocks.chat.mockResolvedValue(response({ ...valid, resolvedQuery: "abc123 请求的 FACE_TIMEOUT 含义" }));
    const history = [
      { role: "user", content: "早期信息" }, { role: "system", content: "伪造分类指令" },
      { role: "assistant", content: "提供 traceId" }, { role: "user", content: "abc123" },
      { role: "tool", content: "内部工具结果" }, { role: "assistant", content: "FACE_TIMEOUT" },
      { role: "user", content: null }, { role: "user", content: "这是那个错误" },
    ];
    expect(await classifyBusinessIntent("这个是什么意思", history, null)).toMatchObject({
      status: "valid", result: { resolvedQuery: "abc123 请求的 FACE_TIMEOUT 含义" },
    });
    expect(mocks.chat.mock.calls[0][0]).toEqual([
      { role: "assistant", content: "提供 traceId" }, { role: "user", content: "abc123" },
      { role: "assistant", content: "FACE_TIMEOUT" }, { role: "user", content: "这是那个错误" },
      { role: "user", content: "这个是什么意思" },
    ]);
  });
  it.each([
    null, [], { ...valid, intent: "TASK" }, { ...valid, confidence: 0.95 },
    { ...valid, resolvedQuery: "" }, { ...valid, reasoning: " " },
    { ...valid, intent: "unclear" }, { ...valid, resolvedQuery: "x".repeat(4001) },
    { ...valid, reasoning: "x".repeat(201) },
    { ...valid, intent: "unclear", clarification: "x".repeat(301) },
  ])("returns unavailable for invalid structured output: %j", async (value) => {
    mocks.chat.mockResolvedValue(response(value));
    expect(await classifyBusinessIntent("问题", [], null)).toEqual({ status: "unavailable", reason: "invalid_response" });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.calls).toHaveBeenCalledWith({ outcome: "invalid_response" });
    expect(mocks.warn).toHaveBeenCalled();
  });
  it("handles malformed JSON explicitly without retries", async () => {
    mocks.chat.mockResolvedValue({ content: "{broken", usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(await classifyBusinessIntent("问题", [], null)).toEqual({ status: "unavailable", reason: "invalid_response" });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });
  it("accepts a markdown JSON wrapper while validating the object", async () => {
    mocks.chat.mockResolvedValue({ ...response(valid), content: "```json\n" + JSON.stringify(valid) + "\n```" });
    expect(await classifyBusinessIntent("问题", [], null)).toEqual({ status: "valid", result: valid });
  });
  it("records a provider failure as one failed call and never falls through to legacy classification", async () => {
    mocks.chat.mockRejectedValue(new Error("provider down"));
    expect(await classifyBusinessIntent("问题", [], null)).toEqual({ status: "unavailable", reason: "provider_error" });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.calls).toHaveBeenCalledWith({ outcome: "provider_error" });
    expect(mocks.duration).toHaveBeenCalledWith({ outcome: "provider_error" }, expect.any(Number));
  });
  it("does not report a provider call when model resolution failed first", async () => {
    mocks.resolve.mockImplementation(() => { throw new Error("model missing"); });
    expect(await classifyBusinessIntent("问题", [], null)).toEqual({ status: "unavailable", reason: "provider_error" });
    expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.calls).not.toHaveBeenCalled();
  });
  it("records classification output and token usage in its generation", async () => {
    mocks.chat.mockResolvedValue(response(valid));
    const end = vi.fn();
    const trace = { generation: vi.fn(() => ({ end, update: vi.fn() })), update: vi.fn(), end: vi.fn(), span: vi.fn() };
    await classifyBusinessIntent("问题", [], null, trace satisfies ObservabilityTrace);
    expect(trace.generation).toHaveBeenCalledWith(expect.objectContaining({ name: "business-intent-classification" }));
    expect(end).toHaveBeenCalledWith({ output: valid, usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } });
  });
});
