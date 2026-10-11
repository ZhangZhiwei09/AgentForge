import { beforeEach, describe, expect, it, vi } from "vitest";
import { decideEntry, explicitEntryControl } from "../entry-decision.js";
import type { EntryDecisionInput } from "../types.js";

const classify = vi.fn();
const load = vi.fn();
const cancel = vi.fn();
const input = (overrides: Partial<EntryDecisionInput> = {}): EntryDecisionInput => ({
  message: "FACE_TIMEOUT 是什么意思？", history: [], safetyDecision: null,
  waitingDiagnosis: false, modelId: null, loadEntryResult: load,
  cancelWaitingDiagnosis: cancel, conversationalReply: null, classify, ...overrides,
});
beforeEach(() => {
  vi.resetAllMocks();
  load.mockResolvedValue(null);
  cancel.mockResolvedValue(true);
  classify.mockResolvedValue({
    status: "valid", result: { intent: "consultation", resolvedQuery: "错误码说明", reasoning: "查询含义" },
  });
});

describe("enterprise entry decision", () => {
  it("safety wins over control, waiting state, configuration and the model", async () => {
    expect(await decideEntry(input({
      message: "转人工", waitingDiagnosis: true,
      safetyDecision: { route: "SAFETY", confidence: 1, reasoning: "安全命中" },
    }))).toMatchObject({ action: "dispatch", route: "SAFETY", source: "safety_rule" });
    expect(load).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });
  it.each(["转人工", "请帮我转接人工支持", "联系人工支持", "我要找人工"])("handles explicit human control: %s", async (message) => {
    expect(await decideEntry(input({ message, waitingDiagnosis: true }))).toMatchObject({
      action: "dispatch", route: "HUMAN", source: "control_rule",
    });
    expect(load).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  });
  it.each([
    "不要转人工，继续排查", "不需要转人工", "如何转人工？", "文档里写着转人工",
    "“转人工”", "'取消排查'", "请解释“转人工”", "不要取消排查", "取消排查是什么意思",
  ])("does not execute negative or quoted control: %s", (message) => {
    expect(explicitEntryControl(message)).toBeNull();
  });
  it.each([true, false])("acknowledges cancellation only when the conditional update succeeded: %s", async (changed) => {
    cancel.mockResolvedValue(changed);
    const decision = await decideEntry(input({ message: "取消当前排查", waitingDiagnosis: true }));
    expect(decision).toMatchObject({ action: "reply", source: "control_rule" });
    if (decision.action === "reply") expect(decision.answer).toBe(
      changed ? "已取消当前等待补充的排查。" : "当前没有可取消的等待排查。",
    );
    expect(cancel).toHaveBeenCalledTimes(1); expect(load).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled();
  });
  it("does not claim to cancel an active or absent run", async () => {
    expect(await decideEntry(input({ message: "停止诊断" }))).toMatchObject({
      action: "reply", answer: "当前没有可取消的等待排查。",
    });
    expect(cancel).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled();
  });
  it.each(["你好", "不要转人工，继续排查", "traceId abc123", "“转人工”"])("waiting state consumes supplements without config or model: %s", async (message) => {
    expect(await decideEntry(input({ message, waitingDiagnosis: true }))).toMatchObject({
      action: "dispatch", route: "DIAGNOSIS", source: "session_state", businessIntent: "diagnosis",
    });
    expect(load).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled();
  });
  it("keeps published replies ahead of conversational shortcuts", async () => {
    load.mockResolvedValue({ action: "reply", answer: "配置回复", suggestions: ["继续"] });
    expect(await decideEntry(input({ conversationalReply: { answer: "问候", suggestions: [] } }))).toMatchObject({
      action: "reply", answer: "配置回复", source: "entry_flow",
    });
    expect(classify).not.toHaveBeenCalled();
  });
  it.each(["CHAT", "TASK", "SAFETY"] as const)("honors configured %s", async (target) => {
    load.mockResolvedValue({ action: "route", target });
    expect(await decideEntry(input())).toMatchObject({ action: "dispatch", route: target, source: "entry_flow" });
    expect(classify).not.toHaveBeenCalled();
  });
  it.each([
    "文档里说登录失败会报 E102", "登录失败是什么意思？", "不要排查登录失败",
    "“帮我排查登录失败”", "解释一下“我登录失败了”", "不需要查一下这个报错",
    "排查登录失败是什么意思", "帮我查登录失败的文档", "排查登录失败有哪些步骤",
    "我登录没有失败", "我的接口并未超时", "我登录失败是什么意思",
    "帮我查登录失败相关文档", "排查登录失败怎么操作", "我登录没有出现失败",
    "我登录失败了，只想看相关文档，不要排查", "帮我查“登录失败”的相关资料",
    "我登录失败了，只想看相关文档", "我登录失败了，不需要继续排查",
    "我登录失败了，帮我查相关文档", "我登录失败了，不需要查日志",
    "排查登录失败怎么做", "我登录失败了，只想看相关文档就行",
    "帮我查登录失败的资料即可", "我登录失败了，只想看相关文档就好",
    "我登录失败了，想看相关文档", "我登录失败了，只想看相关文档就行了",
    "我登录失败了，看看相关文档吧",
  ])("rejects ambiguous configured diagnosis rather than bypassing published configuration: %s", async (message) => {
    load.mockResolvedValue({ action: "route", target: "DIAGNOSIS" });
    expect(await decideEntry(input({ message }))).toMatchObject({ action: "unavailable", source: "entry_flow" });
    expect(classify).not.toHaveBeenCalled();
  });
  it.each([
    "请帮我排查登录失败", "我登录失败了", "这个用户的接口超时", "麻烦帮我查 traceId abc123 失败原因",
    "不需要查文档，请帮我排查登录失败", "请帮我排查知识库接口超时", "请帮我排查用户资料接口超时",
    "请帮我排查文档服务接口超时", "请帮我排查规则引擎报错",
    "我想排查知识库接口超时", "我要排查用户资料接口超时", "我需要排查登录失败",
  ])("accepts affirmative configured diagnosis: %s", async (message) => {
    load.mockResolvedValue({ action: "route", target: "DIAGNOSIS" });
    expect(await decideEntry(input({ message }))).toMatchObject({ action: "dispatch", route: "DIAGNOSIS", source: "entry_flow" });
    expect(classify).not.toHaveBeenCalled();
  });
  it("rejects configured HUMAN without affirmative control", async () => {
    load.mockResolvedValue({ action: "route", target: "HUMAN" });
    expect(await decideEntry(input({ message: "不要转人工，继续排查" }))).toMatchObject({
      action: "unavailable", source: "entry_flow",
    });
    expect(classify).not.toHaveBeenCalled();
  });
  it("uses exact greeting only with no active flow", async () => {
    expect(await decideEntry(input({ conversationalReply: { answer: "问候", suggestions: [] } }))).toMatchObject({
      action: "reply", source: "conversational_rule",
    });
    expect(classify).not.toHaveBeenCalled();
  });
  it("explicit configured continue skips the greeting and calls one classifier", async () => {
    load.mockResolvedValue({ action: "continue" });
    expect(await decideEntry(input({ conversationalReply: { answer: "问候", suggestions: [] } }))).toMatchObject({
      action: "dispatch", route: "TASK", source: "business_llm",
    });
    expect(classify).toHaveBeenCalledTimes(1);
  });
  it.each(["consultation", "diagnosis"] as const)("passes the single %s decision and resolved query to dispatch", async (intent) => {
    const history = [{ role: "user", content: "traceId abc123 登录失败" }];
    classify.mockResolvedValue({ status: "valid", result: { intent, resolvedQuery: "abc123 的原因", reasoning: "结合历史" } });
    expect(await decideEntry(input({ message: "那是什么原因", history }))).toMatchObject({
      action: "dispatch", route: intent === "consultation" ? "TASK" : "DIAGNOSIS",
      source: "business_llm", businessIntent: intent, resolvedQuery: "abc123 的原因",
    });
    expect(classify).toHaveBeenCalledExactlyOnceWith("那是什么原因", history, null, undefined);
  });
  it("clarifies uncertain intent without a default TASK dispatch", async () => {
    classify.mockResolvedValue({ status: "valid", result: {
      intent: "unclear", resolvedQuery: "看看这个", reasoning: "缺少目的", clarification: "想了解说明还是排查实际故障？",
    } });
    expect(await decideEntry(input())).toMatchObject({ action: "clarify", source: "business_llm", answer: "想了解说明还是排查实际故障？" });
    expect(classify).toHaveBeenCalledTimes(1);
  });
  it.each(["provider_error", "invalid_response"])("reports %s without another model call", async (reason) => {
    classify.mockResolvedValue({ status: "unavailable", reason });
    expect(await decideEntry(input())).toMatchObject({ action: "unavailable", source: "business_llm", reasoning: reason });
    expect(classify).toHaveBeenCalledTimes(1);
  });
  it("propagates configuration and cancellation recording errors", async () => {
    load.mockRejectedValue(new Error("配置记录失败"));
    await expect(decideEntry(input())).rejects.toThrow("配置记录失败");
    cancel.mockRejectedValue(new Error("取消写入失败"));
    await expect(decideEntry(input({ message: "取消排查", waitingDiagnosis: true }))).rejects.toThrow("取消写入失败");
    expect(classify).not.toHaveBeenCalled();
  });
  it("does not start cancelled classification", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(decideEntry(input({ signal: abort.signal }))).rejects.toThrow();
    expect(load).not.toHaveBeenCalled(); expect(classify).not.toHaveBeenCalled();
  });
  it("stops after cancelled configuration or model work", async () => {
    const abort = new AbortController();
    load.mockImplementationOnce(async () => { abort.abort(); return null; });
    await expect(decideEntry(input({ signal: abort.signal }))).rejects.toThrow();
    expect(classify).not.toHaveBeenCalled();
    const other = new AbortController();
    classify.mockImplementationOnce(async () => {
      other.abort();
      return { status: "valid", result: { intent: "diagnosis", resolvedQuery: "问题", reasoning: "排查" } };
    });
    await expect(decideEntry(input({ signal: other.signal }))).rejects.toThrow();
    expect(classify).toHaveBeenCalledTimes(1);
  });
});
