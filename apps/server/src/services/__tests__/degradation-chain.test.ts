// DegradationChain tests — alternative tool mapping, degradation message formatting
import { describe, it, expect } from "vitest";
import {
  getAlternativeTools,
  buildDegradationMessage,
  buildLLMDegradationMessage,
} from "../degradation-chain.js";
import { classifyError } from "../error-classifier.js";

describe("getAlternativeTools", () => {
  it("returns alternatives for http_request", () => {
    const alts = getAlternativeTools("http_request");
    expect(alts).toContain("web_search");
    expect(alts).toContain("web_fetch");
  });

  it("returns alternatives for web_search", () => {
    const alts = getAlternativeTools("web_search");
    expect(alts).toContain("web_fetch");
  });

  it("returns read-only alternative for file_write", () => {
    const alts = getAlternativeTools("file_write");
    expect(alts).toContain("file_read");
  });

  it("returns calculator alternative for code_execute", () => {
    const alts = getAlternativeTools("code_execute");
    expect(alts).toContain("calculator");
  });

  it("returns empty array for tools with no alternatives", () => {
    expect(getAlternativeTools("get_current_time")).toEqual([]);
    expect(getAlternativeTools("calculator")).toEqual([]);
    expect(getAlternativeTools("unknown_tool")).toEqual([]);
  });
});

describe("buildDegradationMessage", () => {
  it("builds Chinese degradation message with alternatives", () => {
    const failure = classifyError(
      new Error("Connection timeout"),
      "tool",
      "http_request",
    );
    const msg = buildDegradationMessage(failure, "http_request", 2);

    expect(msg).toContain("[工具执行失败]");
    expect(msg).toContain("http_request");
    expect(msg).toContain("已重试 2 次");
    expect(msg).toContain("Connection timeout");
    expect(msg).toContain("建议替代方案");
    expect(msg).toContain("web_search");
  });

  it("builds message without retry count when 0", () => {
    const failure = classifyError(
      new Error("Circuit breaker open"),
      "tool",
      "db_query",
    );
    const msg = buildDegradationMessage(failure, "db_query", 0);

    expect(msg).not.toContain("已重试");
    expect(msg).toContain("无替代方案");
  });

  it("includes fallback instructions when no alternatives", () => {
    const failure = classifyError(
      new Error("Some error"),
      "tool",
      "get_current_time",
    );
    const msg = buildDegradationMessage(failure, "get_current_time");

    expect(msg).toContain("调整调用参数后重试");
    expect(msg).toContain("向用户说明原因");
  });
});

describe("buildLLMDegradationMessage", () => {
  it("builds Chinese LLM degradation message for rate limit", () => {
    const failure = classifyError(new Error("rate limit exceeded"), "llm");
    const msg = buildLLMDegradationMessage(failure, 2);

    expect(msg).toContain("[模型调用失败]");
    expect(msg).toContain("已重试 2 次");
    expect(msg).toContain("稍等片刻后重试");
  });

  it("builds LLM degradation message for timeout", () => {
    const failure = classifyError(new Error("ETIMEDOUT"), "llm");
    const msg = buildLLMDegradationMessage(failure, 1);

    expect(msg).toContain("简化当前任务描述");
  });
});
