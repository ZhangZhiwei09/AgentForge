// ErrorClassifier tests — classification of LLM/tool/internal errors
import { describe, it, expect } from "vitest";
import {
  classifyError,
  isRetryableError,
  isDegradableError,
  isFatalError,
} from "../error-classifier.js";

describe("classifyError", () => {
  // ---- Retryable ----
  describe("retryable errors", () => {
    it("classifies network errors as retryable", () => {
      const cases = [
        "ECONNRESET",
        "ECONNREFUSED 127.0.0.1:8000",
        "ETIMEDOUT",
        "ENOTFOUND api.openai.com",
        "fetch failed",
        "socket hang up",
        "network error occurred",
      ];
      for (const msg of cases) {
        const result = classifyError(new Error(msg), "llm");
        expect(result.category, `"${msg}" should be retryable`).toBe(
          "retryable",
        );
        expect(result.recoverable).toBe(true);
      }
    });

    it("classifies HTTP server errors as retryable", () => {
      const cases = [
        "HTTP 429 Too Many Requests",
        "502 Bad Gateway",
        "503 Service Unavailable",
        "504 Gateway Timeout",
      ];
      for (const msg of cases) {
        const result = classifyError(new Error(msg), "llm");
        expect(result.category).toBe("retryable");
      }
    });

    it("classifies rate limit errors as retryable", () => {
      const cases = [
        "rate limit exceeded",
        "Too many requests, please retry",
        "quota exceeded for this minute",
      ];
      for (const msg of cases) {
        const result = classifyError(new Error(msg), "llm");
        expect(result.category).toBe("retryable");
      }
    });

    it("classifies timeout errors as retryable", () => {
      const cases = [
        "timeout",
        "timed out after 30s",
        "Request timed out",
        "Connection timed_out",
        "aborted",
        "request cancelled",
      ];
      for (const msg of cases) {
        const result = classifyError(new Error(msg), "tool", "http_request");
        expect(result.category).toBe("retryable");
      }
    });

    it("detects correct retryable reason", () => {
      expect(
        classifyError(new Error("rate limit exceeded"), "llm").retryableReason,
      ).toBe("rate_limit");
      expect(
        classifyError(new Error("timeout after 30s"), "llm").retryableReason,
      ).toBe("timeout");
      expect(
        classifyError(new Error("ECONNRESET"), "llm").retryableReason,
      ).toBe("network");
      expect(classifyError(new Error("503 error"), "llm").retryableReason).toBe(
        "server_error",
      );
    });
  });

  // ---- Fatal ----
  describe("fatal errors", () => {
    it("classifies auth/API key errors as fatal", () => {
      const cases = [
        "HTTP 401 Unauthorized",
        "403 Forbidden",
        "invalid api key",
        "incorrect api key provided",
        "authentication failed",
        "not authorized to access this resource",
      ];
      for (const msg of cases) {
        const result = classifyError(new Error(msg), "llm");
        expect(result.category, `"${msg}" should be fatal`).toBe("fatal");
        expect(result.recoverable).toBe(false);
      }
    });

    it("classifies billing/quota errors as fatal", () => {
      const cases = [
        "HTTP 402 Payment Required",
        "insufficient_quota",
        "billing account not found",
        "exceeded your current quota",
        "account balance insufficient",
      ];
      for (const msg of cases) {
        expect(classifyError(new Error(msg), "llm").category).toBe("fatal");
      }
    });

    it("classifies model/config errors as fatal", () => {
      const cases = [
        "model not found: gpt-5",
        "model does not exist",
        "invalid model specified",
        "tool not found: nonexistent_tool",
        "unknown tool",
      ];
      for (const msg of cases) {
        expect(classifyError(new Error(msg), "tool").category).toBe("fatal");
      }
    });

    it("classifies context length exceeded as fatal", () => {
      const cases = [
        "context length exceeded",
        "maximum context length is 128000 tokens",
      ];
      for (const msg of cases) {
        expect(classifyError(new Error(msg), "llm").category).toBe("fatal");
      }
    });
  });

  // ---- Degradable ----
  describe("degradable errors", () => {
    it("classifies tool execution errors as degradable", () => {
      const result = classifyError(
        new Error("Some tool error"),
        "tool",
        "http_request",
      );
      expect(result.category).toBe("degradable");
      expect(result.recoverable).toBe(true);
      expect(result.degradedTool).toBe("http_request");
    });

    it("classifies circuit breaker errors as degradable", () => {
      const result = classifyError(
        new Error(
          "tool http_request is temporarily disabled (circuit breaker open)",
        ),
        "tool",
        "http_request",
      );
      expect(result.category).toBe("degradable");
    });

    it("classifies model overloaded as degradable", () => {
      const result = classifyError(
        new Error("model overloaded, try again later"),
        "llm",
      );
      expect(result.category).toBe("degradable");
    });

    it("classifies generic service unavailable as degradable", () => {
      const result = classifyError(
        new Error("service temporarily unavailable"),
        "llm",
      );
      expect(result.category).toBe("degradable");
    });
  });

  // ---- Default fallback ----
  describe("default fallback", () => {
    it("defaults unknown errors to degradable (safe default)", () => {
      const result = classifyError(
        new Error("some random unknown error message"),
        "internal",
      );
      expect(result.category).toBe("degradable");
      expect(result.recoverable).toBe(true);
    });
  });

  // ---- Non-Error inputs ----
  describe("non-Error inputs", () => {
    it("handles non-Error objects gracefully", () => {
      const result = classifyError(new Error(""), "internal");
      expect(result.category).toBe("degradable");
    });
  });

  // ---- Source tagging ----
  describe("source tagging", () => {
    it("correctly tags source", () => {
      expect(classifyError(new Error("ECONNRESET"), "llm").source).toBe("llm");
      expect(
        classifyError(new Error("ECONNRESET"), "tool", "calculator").source,
      ).toBe("tool");
      expect(classifyError(new Error("ECONNRESET"), "internal").source).toBe(
        "internal",
      );
    });
  });
});

// ---- Convenience functions ----
describe("convenience functions", () => {
  const retryable = classifyError(new Error("ECONNRESET"), "llm");
  const fatal = classifyError(new Error("401 Unauthorized"), "llm");
  const degradable = classifyError(
    new Error("tool error"),
    "tool",
    "http_request",
  );

  it("isRetryableError", () => {
    expect(isRetryableError(retryable)).toBe(true);
    expect(isRetryableError(fatal)).toBe(false);
    expect(isRetryableError(degradable)).toBe(false);
  });

  it("isFatalError", () => {
    expect(isFatalError(fatal)).toBe(true);
    expect(isFatalError(retryable)).toBe(false);
    expect(isFatalError(degradable)).toBe(false);
  });

  it("isDegradableError", () => {
    expect(isDegradableError(degradable)).toBe(true);
    expect(isDegradableError(retryable)).toBe(false);
    expect(isDegradableError(fatal)).toBe(false);
  });
});
