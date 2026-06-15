import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRunContext } from "../../runtime/context.js";
import { executionResultToContent } from "../../runtime/results.js";

// We test the web_fetch tool — mock global fetch
const { networkTools } = await import("../network-tools.js");

const testCtx = createRunContext(new AbortController().signal);

describe("web_fetch tool", () => {
  const webFetchTool = networkTools[0];
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("should be registered with correct metadata", () => {
    expect(webFetchTool.definition.function.name).toBe("web_fetch");
    expect(webFetchTool.riskLevel).toBe("read_only");
    expect(webFetchTool.category).toBe("network");
    expect(webFetchTool.requireApproval).toBe(false);
    expect(webFetchTool.parallelizable).toBe(true);
    expect(webFetchTool.timeout).toBe(20_000);
  });

  it("should fetch a URL and return content", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/html"]]),
      text: async () => "<html><body>Hello World</body></html>",
    } as unknown as Response);

    const result = await webFetchTool.execute({ url: "https://example.com" }, testCtx);
    const parsed = JSON.parse(result.output);

    expect(result.status).toBe("success");
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.status).toBe(200);
    expect(parsed.content_type).toBe("text/html");
    expect(parsed.content).toContain("Hello World");
  });

  it("should truncate content beyond max_chars", async () => {
    const longContent = "a".repeat(2000);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => longContent,
    } as unknown as Response);

    const result = await webFetchTool.execute({
      url: "https://example.com",
      max_chars: 500,
    }, testCtx);
    // For partial results, parse .output directly (executionResultToContent adds note prefix)
    const parsed = JSON.parse(result.output);

    expect(result.status).toBe("partial");
    expect(parsed.content.length).toBeLessThanOrEqual(500);
    expect(parsed.truncated).toBe(true);
  });

  it("should reject invalid URLs", async () => {
    const result = await webFetchTool.execute({ url: "not-a-url" }, testCtx);
    expect(result.status).toBe("failed");
    expect(executionResultToContent(result)).toContain("http");
  });

  it("should reject URLs without http/https prefix", async () => {
    const result = await webFetchTool.execute({ url: "ftp://example.com" }, testCtx);
    expect(result.status).toBe("failed");
  });

  it("should handle HTTP error status codes", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    } as unknown as Response);

    const result = await webFetchTool.execute({
      url: "https://example.com/404",
    }, testCtx);
    expect(result.status).toBe("failed");
    expect(executionResultToContent(result)).toContain("404");
  });

  it("should handle network errors gracefully", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await webFetchTool.execute({ url: "https://example.com" }, testCtx);
    expect(result.status).toBe("failed");
    expect(executionResultToContent(result)).toContain("Network error");
  });

  it("should use default max_chars when not specified", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "short content",
    } as unknown as Response);

    const result = await webFetchTool.execute({ url: "https://example.com" }, testCtx);
    const parsed = JSON.parse(result.output);

    // Default is 10000, content is shorter
    expect(result.status).toBe("success");
    expect(parsed.truncated).toBe(false);
  });

  it("should return error for missing URL parameter", async () => {
    const result = await webFetchTool.execute({}, testCtx);
    expect(result.status).toBe("failed");
  });
});
