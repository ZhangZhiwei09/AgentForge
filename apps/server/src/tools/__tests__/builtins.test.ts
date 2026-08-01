import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { builtinTools } from "../builtins.js";
import { createRunContext } from "../../runtime/context.js";
import {
  successResult,
  failedResult,
  partialResult,
  ExecutionErrorCode,
  executionResultToContent,
} from "../../runtime/results.js";
import type { RegisteredTool } from "../types.js";
import type { RunContext } from "../../runtime/context.js";
import type { ExecutionResult } from "../../runtime/results.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a built-in tool by its function name */
function getTool(name: string): RegisteredTool {
  const tool = builtinTools.find(
    (t) => t.definition.function.name === name,
  );
  if (!tool) throw new Error(`Built-in tool not found: ${name}`);
  return tool;
}

/** Create a minimal RunContext for testing */
function makeCtx(): RunContext {
  return createRunContext(new AbortController().signal);
}

// ---------------------------------------------------------------------------
// Metadata & structural tests
// ---------------------------------------------------------------------------

describe("builtinTools metadata", () => {
  it("should export exactly 4 tools", () => {
    expect(builtinTools).toHaveLength(4);
  });

  it("should have unique tool names", () => {
    const names = builtinTools.map((t) => t.definition.function.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(builtinTools)(
    "$definition.function.name should have all required metadata fields",
    (tool: RegisteredTool) => {
      expect(tool.definition).toBeDefined();
      expect(tool.definition.type).toBe("function");
      expect(tool.definition.function.name).toBeTruthy();
      expect(tool.definition.function.description).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
      expect(tool.riskLevel).toBeDefined();
      expect(["safe", "read_only", "mutation", "destructive"]).toContain(
        tool.riskLevel,
      );
      expect(typeof tool.timeout).toBe("number");
      expect(tool.timeout).toBeGreaterThan(0);
      expect(typeof tool.requireApproval).toBe("boolean");
      expect(typeof tool.category).toBe("string");
      expect(tool.category.length).toBeGreaterThan(0);
      expect(typeof tool.parallelizable).toBe("boolean");
    },
  );
});

// ---------------------------------------------------------------------------
// get_current_time
// ---------------------------------------------------------------------------

describe("get_current_time", () => {
  let tool: RegisteredTool;

  beforeEach(() => {
    tool = getTool("get_current_time");
  });

  it("should return success with a formatted date string for UTC", async () => {
    const result = await tool.execute({ timezone: "UTC" }, makeCtx());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      // Output should look like "Monday, July 14, 2026 at 10:30:45 AM UTC"
      expect(result.output).toMatch(
        /[A-Z][a-z]+,\s[A-Z][a-z]+\s\d{1,2},\s\d{4}\sat\s\d{2}:\d{2}:\d{2}\s[A-M][A-Z]/,
      );
    }
  });

  it("should default to UTC when no timezone is provided", async () => {
    const result = await tool.execute({}, makeCtx());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toContain("UTC");
    }
  });

  it("should return success for a valid non-UTC timezone (Asia/Shanghai)", async () => {
    const result = await tool.execute(
      { timezone: "Asia/Shanghai" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toContain("GMT+8");
    }
  });

  it("should return success for America/New_York", async () => {
    const result = await tool.execute(
      { timezone: "America/New_York" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    // Eastern timezone abbreviation varies with DST (EDT/EST)
    if (result.status === "success") {
      expect(result.output).toMatch(/E[DS]T/);
    }
  });

  it("should return partialResult with fallback for an invalid timezone", async () => {
    const result = await tool.execute(
      { timezone: "Mars/Olympus_Mons" },
      makeCtx(),
    );

    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("not recognized");
      expect(result.output).toContain("Mars/Olympus_Mons");
      expect(result.output).toContain("Current UTC time:");
    }
  });

  it("should treat empty timezone string as UTC (falsy fallback)", async () => {
    // Empty string is falsy, so ("" || "UTC") = "UTC" — valid timezone
    const result = await tool.execute({ timezone: "" }, makeCtx());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.output).toContain("UTC");
    }
  });

  it("should use Intl.DateTimeFormat via side-effect detection (valid tz produces formatted output)", async () => {
    // We can't directly mock Intl.DateTimeFormat easily but we can verify the
    // output format matches en-US locale conventions with long month/weekday
    const result = await tool.execute({ timezone: "UTC" }, makeCtx());

    expect(result.status).toBe("success");
    if (result.status === "success") {
      // Long format: "Monday" not "Mon", "July" not "Jul" or "07"
      expect(result.output).toMatch(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/);
      expect(result.output).toMatch(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/);
      // 12-hour clock with AM/PM
      expect(result.output).toMatch(/\d{2}:\d{2}:\d{2}\s[AP]M/);
    }
  });

  it("should include timezone offset in output for Asia/Tokyo", async () => {
    const result = await tool.execute(
      { timezone: "Asia/Tokyo" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      // Platform-dependent: may be "JST" or "GMT+9" — both indicate Japan time
      expect(result.output).toMatch(/(JST|GMT\+9)/);
    }
  });
});

// ---------------------------------------------------------------------------
// calculator
// ---------------------------------------------------------------------------

describe("calculator", () => {
  let tool: RegisteredTool;

  beforeEach(() => {
    tool = getTool("calculator");
  });

  // --- success cases ---

  it("should evaluate simple addition", async () => {
    const result = await tool.execute({ expression: "2 + 3" }, makeCtx());

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("5");
  });

  it("should evaluate multiplication with correct precedence", async () => {
    const result = await tool.execute(
      { expression: "2 + 3 * 4" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("14");
  });

  it("should evaluate parentheses", async () => {
    const result = await tool.execute(
      { expression: "(2 + 3) * 4" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("20");
  });

  it("should evaluate exponentiation", async () => {
    const result = await tool.execute(
      { expression: "2 ** 10" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("1024");
  });

  it("should evaluate modulo", async () => {
    const result = await tool.execute(
      { expression: "17 % 5" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("2");
  });

  it("should evaluate sqrt function", async () => {
    const result = await tool.execute(
      { expression: "sqrt(144)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("12");
  });

  it("should evaluate sin function", async () => {
    const result = await tool.execute(
      { expression: "sin(0)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("0");
  });

  it("should evaluate cos function", async () => {
    const result = await tool.execute(
      { expression: "cos(0)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("1");
  });

  it("should evaluate tan function", async () => {
    const result = await tool.execute(
      { expression: "tan(0)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("0");
  });

  it("should evaluate log function", async () => {
    const result = await tool.execute(
      { expression: "log(1)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("0");
  });

  it("should evaluate exp function", async () => {
    const result = await tool.execute(
      { expression: "exp(0)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("1");
  });

  it("should evaluate abs function", async () => {
    const result = await tool.execute(
      { expression: "abs(-42)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("42");
  });

  it("should evaluate round function", async () => {
    const result = await tool.execute(
      { expression: "round(3.7)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("4");
  });

  it("should evaluate floor function", async () => {
    const result = await tool.execute(
      { expression: "floor(3.7)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("3");
  });

  it("should evaluate ceil function", async () => {
    const result = await tool.execute(
      { expression: "ceil(3.2)" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("4");
  });

  it("should evaluate PI constant", async () => {
    const result = await tool.execute(
      { expression: "PI" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    // Should be ~3.14159...
    expect(executionResultToContent(result)).toMatch(/^3\.14/);
  });

  it("should evaluate E constant", async () => {
    const result = await tool.execute(
      { expression: "E" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toMatch(/^2\.71/);
  });

  it("should evaluate negative numbers", async () => {
    const result = await tool.execute(
      { expression: "-5 + 3" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("-2");
  });

  it("should evaluate floating point numbers", async () => {
    const result = await tool.execute(
      { expression: "0.1 + 0.2" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("0.3");
  });

  it("should format integer results without decimal point", async () => {
    const result = await tool.execute(
      { expression: "10 / 2" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("5");
  });

  it("should combine functions and arithmetic", async () => {
    const result = await tool.execute(
      { expression: "sqrt(abs(-16)) + PI" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    // sqrt(16) + PI = 4 + 3.14159... ≈ 7.14...
    const output = executionResultToContent(result);
    expect(output).toMatch(/^7\.14/);
  });

  // --- error cases ---

  it("should return failedResult for empty expression", async () => {
    const result = await tool.execute({ expression: "" }, makeCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toBe("Empty expression");
    }
  });

  it("should return failedResult for whitespace-only expression", async () => {
    const result = await tool.execute(
      { expression: "   " },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
    }
  });

  it("should return failedResult for expression exceeding 500 characters", async () => {
    const longExpr = "1" + "+1".repeat(250); // >500 chars
    expect(longExpr.length).toBeGreaterThan(500);

    const result = await tool.execute(
      { expression: longExpr },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toContain("too long");
    }
  });

  it("should accept expression exactly at 500 characters", async () => {
    // "1" + "+1" * 166 = 1 + 332 = 333; need 500
    // "1" + "+1" * 249 = 1 + 498 = 499; one more "+1" = 502... too much
    // Let's construct exactly 500: "1" + "+1".repeat(249) = 1 + 498 = 499, need one more char
    const expr = "1" + "+1".repeat(249); // 499 chars
    const padded = expr.padEnd(500, " ");
    const expr500 = "1" + "+1".repeat(166); // 1 + 332 = 333, need more
    // Simpler: build exactly 500 chars of valid expression
    let exactly500 = "1";
    while (exactly500.length < 500) {
      exactly500 += "+1";
    }
    exactly500 = exactly500.slice(0, 500);

    const result = await tool.execute(
      { expression: exactly500 },
      makeCtx(),
    );

    // Should not fail for length
    if (result.status === "failed") {
      expect(result.error.message).not.toContain("too long");
    }
  });

  it("should return failedResult for disallowed characters (semicolons)", async () => {
    const result = await tool.execute(
      { expression: "2+2; console.log('hi')" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toContain("disallowed");
    }
  });

  it("should return failedResult for disallowed characters (letters without math meaning)", async () => {
    const result = await tool.execute(
      { expression: "require('fs')" },
      makeCtx(),
    );

    // Single quotes are not in the safe regex, so this should fail
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
    }
  });

  it("should return failedResult for backticks in expression", async () => {
    const result = await tool.execute(
      { expression: "`rm -rf /`" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
    }
  });

  it("should return failedResult for expression containing colon (prototype pollution attempt)", async () => {
    const result = await tool.execute(
      { expression: "__proto__: {}" },
      makeCtx(),
    );

    // Colon is not in the safe regex
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
    }
  });

  it("should handle division by zero (returns Infinity → not finite → failed)", async () => {
    const result = await tool.execute({ expression: "1 / 0" }, makeCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
      expect(result.error.message).toContain("not a finite number");
    }
  });

  it("should handle negative square root (returns NaN → not finite → failed)", async () => {
    const result = await tool.execute(
      { expression: "sqrt(-1)" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
    }
  });

  it("should handle syntax error in expression", async () => {
    // "2 3" is a genuine JS syntax error (two adjacent numeric literals)
    const result = await tool.execute(
      { expression: "2 3" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
      expect(result.error.message).toContain("Error evaluating expression");
    }
  });

  it("should handle missing closing parenthesis", async () => {
    const result = await tool.execute(
      { expression: "(2 + 3" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.EXECUTION_ERROR);
    }
  });

  it("should handle expression with whitespace only around valid content", async () => {
    const result = await tool.execute(
      { expression: "   42   " },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(executionResultToContent(result)).toBe("42");
  });

  it("should handle very large numbers without precision issues", async () => {
    const result = await tool.execute(
      { expression: "1e308" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    // 1e308 is valid, just very large
    const content = executionResultToContent(result);
    expect(content).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

describe("web_search", () => {
  let tool: RegisteredTool;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tool = getTool("web_search");
    // Clear API keys for isolated testing
    delete process.env.TAVILY_API_KEY;
    delete process.env.SERPAPI_API_KEY;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Restore env
    process.env.TAVILY_API_KEY = originalEnv.TAVILY_API_KEY;
    process.env.SERPAPI_API_KEY = originalEnv.SERPAPI_API_KEY;
  });

  // --- validation ---

  it("should return failedResult for empty query string", async () => {
    const result = await tool.execute({ query: "" }, makeCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toBe("Empty search query");
    }
  });

  it("should return failedResult for whitespace-only query", async () => {
    const result = await tool.execute(
      { query: "    " },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
    }
  });

  // --- missing API key ---

  it("should return partialResult with simulated results when no API key is set", async () => {
    const result = await tool.execute(
      { query: "test query" },
      makeCtx(),
    );

    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("API key not configured");
      const parsed = JSON.parse(result.output);
      expect(parsed.note).toContain("API key not configured");
      expect(parsed.query).toBe("test query");
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].title).toContain("test query");
      expect(parsed.results[0].url).toBe("https://tavily.com");
    }
  });

  it("should return partialResult when only TAVILY_API_KEY is empty string", async () => {
    process.env.TAVILY_API_KEY = "";

    const result = await tool.execute(
      { query: "something" },
      makeCtx(),
    );

    expect(result.status).toBe("partial");
  });

  // --- successful search with mocked fetch ---

  it("should call Tavily API and return success with parsed results", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key-123";

    const mockResults = [
      {
        title: "Test Result 1",
        url: "https://example.com/1",
        content: "This is the first test result content.",
        score: 0.95,
      },
      {
        title: "Test Result 2",
        url: "https://example.com/2",
        content:
          "This is the second test result with longer content that exceeds 300 chars." +
          "x".repeat(300),
        score: 0.87,
      },
      {
        title: "Test Result 3",
        url: "https://example.com/3",
        content: "Third result.",
        score: 0.76,
      },
    ];

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        answer: "This is a test answer from Tavily.",
        results: mockResults,
      }),
    });

    const result = await tool.execute(
      { query: "test query", max_results: 3 },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.query).toBe("test query");
      expect(parsed.answer).toBe("This is a test answer from Tavily.");
      expect(parsed.results).toHaveLength(3);
      expect(parsed.results[0].title).toBe("Test Result 1");
      expect(parsed.results[0].url).toBe("https://example.com/1");
      expect(parsed.results[0].snippet).toBe(
        "This is the first test result content.",
      );
      expect(parsed.results[0].score).toBe(0.95);
      // Content should be truncated to 300 chars
      expect(parsed.results[1].snippet.length).toBeLessThanOrEqual(300);
      expect(parsed.total).toBe(3);
    }

    // Verify fetch was called correctly
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(fetchCall[0]).toBe("https://api.tavily.com/search");
    expect(fetchCall[1].method).toBe("POST");
    expect(fetchCall[1].headers["Content-Type"]).toBe("application/json");
    expect(fetchCall[1].headers["Authorization"]).toBe(
      "Bearer tvly-test-key-123",
    );
    const body = JSON.parse(fetchCall[1].body);
    expect(body.query).toBe("test query");
    expect(body.max_results).toBe(3);
    expect(body.search_depth).toBe("basic");
    expect(body.include_answer).toBe(true);
  });

  it("should use SERPAPI_API_KEY when TAVILY_API_KEY is not set", async () => {
    process.env.SERPAPI_API_KEY = "serpapi-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        answer: null,
        results: [
          {
            title: "Serp Result",
            url: "https://example.com/serp",
            content: "Serp content.",
            score: 0.9,
          },
        ],
      }),
    });

    const result = await tool.execute(
      { query: "serp test" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    const fetchHeader =
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(fetchHeader["Authorization"]).toBe("Bearer serpapi-test-key");
  });

  it("should handle null answer field gracefully", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        // no answer field
        results: [
          {
            title: "No Answer",
            url: "https://example.com/no-answer",
            content: "Content without answer field.",
            score: 0.5,
          },
        ],
      }),
    });

    const result = await tool.execute(
      { query: "no answer test" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.answer).toBe(null);
      expect(parsed.results).toHaveLength(1);
    }
  });

  it("should handle empty results array", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        answer: null,
        results: [],
      }),
    });

    const result = await tool.execute(
      { query: "no results" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.results).toHaveLength(0);
      expect(parsed.total).toBe(0);
    }
  });

  // --- HTTP error ---

  it("should return failedResult on API error response", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "Rate limit exceeded",
    });

    const result = await tool.execute(
      { query: "rate limited" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.API_ERROR);
      expect(result.error.message).toContain("429");
      expect(result.error.message).toContain("Rate limit exceeded");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("should handle 500 server error", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: async () => "Server error",
    });

    const result = await tool.execute(
      { query: "server error test" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.API_ERROR);
      expect(result.error.message).toContain("500");
      expect(result.error.retryable).toBe(true);
    }
  });

  // --- max_results bounding ---

  it("should default max_results to 5 when not provided", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        answer: null,
        results: [],
      }),
    });

    await tool.execute({ query: "default max" }, makeCtx());

    const body = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.max_results).toBe(5);
  });

  it("should default max_results to 5 when 0 is provided (falsy fallback)", async () => {
    // 0 is falsy, so (0 || 5) = 5 — the || takes precedence over Math.max
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ answer: null, results: [] }),
    });

    await tool.execute(
      { query: "zero bound", max_results: 0 },
      makeCtx(),
    );

    const body = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.max_results).toBe(5);
  });

  it("should clamp max_results to maximum of 10", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ answer: null, results: [] }),
    });

    await tool.execute(
      { query: "max bound", max_results: 100 },
      makeCtx(),
    );

    const body = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.max_results).toBe(10);
  });

  it("should clamp max_results when negative", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ answer: null, results: [] }),
    });

    await tool.execute(
      { query: "negative bound", max_results: -5 },
      makeCtx(),
    );

    const body = JSON.parse(
      (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body.max_results).toBe(1);
  });

  // --- network error ---

  it("should return failedResult on network/fetch error", async () => {
    process.env.TAVILY_API_KEY = "tvly-test-key";

    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network timeout"));

    const result = await tool.execute(
      { query: "network error" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.API_ERROR);
      expect(result.error.message).toContain("Network timeout");
      expect(result.error.retryable).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// http_request
// ---------------------------------------------------------------------------

describe("http_request", () => {
  let tool: RegisteredTool;

  beforeEach(() => {
    tool = getTool("http_request");
    vi.restoreAllMocks();
  });

  // --- validation ---

  it("should return failedResult for empty URL", async () => {
    const result = await tool.execute({ url: "" }, makeCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toBe("URL is required");
    }
  });

  it("should return failedResult when URL is not provided at all", async () => {
    const result = await tool.execute({}, makeCtx());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toBe("URL is required");
    }
  });

  it("should return failedResult for non-HTTP URL (ftp)", async () => {
    const result = await tool.execute(
      { url: "ftp://files.example.com/data" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toContain("must start with http");
    }
  });

  it("should return failedResult for file:// URL", async () => {
    const result = await tool.execute(
      { url: "file:///etc/passwd" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toContain("must start with http");
    }
  });

  it("should return failedResult for URL without protocol", async () => {
    const result = await tool.execute(
      { url: "example.com" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.INVALID_PARAM);
      expect(result.error.message).toContain("must start with http");
    }
  });

  // --- GET success ---

  it("should make GET request and return success with JSON response", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({
        "content-type": "application/json",
        "x-custom": "test-value",
      }),
      json: async () => ({ id: 1, name: "test" }),
    };

    global.fetch = vi.fn().mockResolvedValueOnce(mockResponse);

    const result = await tool.execute(
      { url: "https://api.example.com/users/1" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe(200);
      expect(parsed.statusText).toBe("OK");
      const bodyParsed = JSON.parse(parsed.body);
      expect(bodyParsed).toEqual({ id: 1, name: "test" });
    }

    // Verify fetch called correctly
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.example.com/users/1",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "User-Agent": "AgentForge/1.0",
          Accept: "application/json, text/plain, */*",
        }),
      }),
    );
  });

  it("should make GET request and return success with text response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({
        "content-type": "text/plain",
      }),
      text: async () => "plain text response",
    });

    const result = await tool.execute(
      { url: "https://example.com/robots.txt" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.body).toBe("plain text response");
    }
  });

  it("should default method to GET when not specified", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "ok",
    });

    await tool.execute(
      { url: "https://example.com/api" },
      makeCtx(),
    );

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(fetchCall[1].method).toBe("GET");
  });

  // --- POST with body ---

  it("should make POST request with body and Content-Type header", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      statusText: "Created",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ id: 42, status: "created" }),
    });

    const result = await tool.execute(
      {
        url: "https://api.example.com/users",
        method: "POST",
        body: JSON.stringify({ name: "Alice" }),
      },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe(201);
    }

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(fetchCall[1].method).toBe("POST");
    expect(fetchCall[1].body).toBe(JSON.stringify({ name: "Alice" }));
    expect(fetchCall[1].headers).toMatchObject({
      "Content-Type": "application/json",
      "User-Agent": "AgentForge/1.0",
    });
  });

  it("should not set Content-Type for POST without body", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ ok: true }),
    });

    await tool.execute(
      {
        url: "https://api.example.com/empty-post",
        method: "POST",
      },
      makeCtx(),
    );

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    // Content-Type should NOT be set for POST without body
    expect(fetchCall[1].headers).not.toHaveProperty("Content-Type");
  });

  // --- custom headers ---

  it("should merge custom headers with defaults", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({}),
    });

    await tool.execute(
      {
        url: "https://api.example.com/data",
        headers: {
          Authorization: "Bearer token123",
          "X-Custom": "my-value",
        },
      },
      makeCtx(),
    );

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(fetchCall[1].headers).toMatchObject({
      "User-Agent": "AgentForge/1.0",
      Accept: "application/json, text/plain, */*",
      Authorization: "Bearer token123",
      "X-Custom": "my-value",
    });
  });

  // --- response truncation ---

  it("should return partialResult with truncated body when response exceeds 5000 characters", async () => {
    // Create a response body > 5000 chars
    const longBody = { data: "x".repeat(6000) };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => longBody,
    });

    const result = await tool.execute(
      { url: "https://api.example.com/large-data" },
      makeCtx(),
    );

    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.reason).toContain("truncated");
      expect(result.reason).toContain("5000");
      const parsed = JSON.parse(result.output);
      const body: string = parsed.body;
      expect(body).toContain("... (truncated)");
      // The body in output should be the stringified longBody truncated
      expect(body.length).toBeLessThanOrEqual(5000 + " (truncated)".length + 3); // +3 for "..."
      expect(body.endsWith("... (truncated)")).toBe(true);
    }
  });

  it("should return successResult when response is exactly at truncation boundary", async () => {
    // Create a response body exactly 5000 chars
    const exactBody = { data: "y".repeat(4983) }; // {"data":"... (5000 total when stringified)
    // Let's be more precise: we need the stringified JSON to be exactly 5000
    const str = JSON.stringify({ data: "z" });
    const overhead = str.length - 1; // minus the single 'z'
    const fillLength = 5000 - overhead;
    const exactData = { data: "a".repeat(fillLength) };

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => exactData,
    });

    const result = await tool.execute(
      { url: "https://api.example.com/exact-boundary" },
      makeCtx(),
    );

    // Should be success (not partial) because it's exactly 5000
    expect(result.status).toBe("success");
  });

  // --- network error ---

  it("should return failedResult on network error", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("Connection refused"));

    const result = await tool.execute(
      { url: "https://api.example.com/offline" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.NETWORK_ERROR);
      expect(result.error.message).toContain("Connection refused");
      expect(result.error.retryable).toBe(true);
    }
  });

  it("should handle non-Error throw (string)", async () => {
    global.fetch = vi.fn().mockRejectedValueOnce("some string error");

    const result = await tool.execute(
      { url: "https://api.example.com/bad" },
      makeCtx(),
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.NETWORK_ERROR);
      expect(result.error.message).toContain("Unknown error");
    }
  });

  // --- HTTPS support ---

  it("should accept https:// URLs", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "secure",
    });

    const result = await tool.execute(
      { url: "https://secure.example.com" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    expect(global.fetch).toHaveBeenCalledWith(
      "https://secure.example.com",
      expect.anything(),
    );
  });

  it("should accept http:// URLs", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "insecure",
    });

    const result = await tool.execute(
      { url: "http://insecure.example.com" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
  });

  // --- response headers in output ---

  it("should include response headers in output", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({
        "content-type": "application/json",
        "x-rate-limit": "100",
        "x-request-id": "abc-123",
      }),
      json: async () => ({ ok: true }),
    });

    const result = await tool.execute(
      { url: "https://api.example.com/with-headers" },
      makeCtx(),
    );

    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.headers).toBeDefined();
      expect(parsed.headers["x-rate-limit"]).toBe("100");
      expect(parsed.headers["x-request-id"]).toBe("abc-123");
    }
  });

  // --- HTTP error responses from target ---

  it("should return success even for 404 responses (HTTP level success, not tool failure)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ error: "Not found" }),
    });

    const result = await tool.execute(
      { url: "https://api.example.com/missing" },
      makeCtx(),
    );

    // The tool itself executed successfully — it's reporting the HTTP 404
    // Note: fetch doesn't throw on 4xx, only on network errors
    expect(result.status).toBe("success");
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.status).toBe(404);
      expect(parsed.statusText).toBe("Not Found");
    }
  });

  it("should pass AbortSignal from context to fetch", async () => {
    const controller = new AbortController();
    const ctx = createRunContext(controller.signal);

    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "ok",
    });

    await tool.execute(
      { url: "https://api.example.com/signal" },
      ctx,
    );

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(fetchCall[1].signal).toBe(controller.signal);
  });
});
