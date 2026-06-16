// Built-in tools for V4 Tool Calling + P1-6 Tool Ecosystem Enhancement
// Each tool exports its definition and executor function with risk levels
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";
import type { RunContext } from "../runtime/context.js";
import type { ExecutionResult } from "../runtime/results.js";
import {
  successResult,
  failedResult,
  partialResult,
  ExecutionErrorCode,
} from "../runtime/results.js";

// ---------------------------------------------------------------------------
// 1. get_current_time — returns current date/time with optional timezone
// ---------------------------------------------------------------------------

const getCurrentTimeDef: ToolDefinition = {
  type: "function",
  function: {
    name: "get_current_time",
    description:
      "Get the current date and time. Use this when the user asks what time it is, what day it is, or needs a timestamp. Supports optional IANA timezone (e.g. 'Asia/Shanghai', 'America/New_York').",
    parameters: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
          description:
            "IANA timezone name (e.g. 'Asia/Shanghai', 'America/New_York'). Defaults to UTC if not provided.",
        },
      },
      required: [],
    },
  },
};

async function getCurrentTimeExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<ExecutionResult> {
  const timezone = (args.timezone as string) || "UTC";
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
    return successResult(formatter.format(now));
  } catch {
    const now = new Date();
    return partialResult(
      `Invalid timezone "${timezone}". Current UTC time: ${now.toISOString()}`,
      `Timezone "${timezone}" not recognized, fell back to UTC`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. calculator — safe math expression evaluator
// ---------------------------------------------------------------------------

const calculatorDef: ToolDefinition = {
  type: "function",
  function: {
    name: "calculator",
    description:
      "Evaluate a mathematical expression. Supports: +, -, *, /, ** (power), % (modulo), parentheses, and common functions: sqrt, abs, round, floor, ceil, sin, cos, tan, log, exp, PI, E. Use this for any arithmetic or math calculations.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description:
            "The mathematical expression to evaluate (e.g. '(15 * 23) + 7', 'sqrt(144)', '2 ** 10')",
        },
      },
      required: ["expression"],
    },
  },
};

async function calculatorExecute(
  args: Record<string, unknown>,
  _context: RunContext,
): Promise<ExecutionResult> {
  const expression = (args.expression as string) || "";

  if (!expression.trim()) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, "Empty expression");
  }
  if (expression.length > 500) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, "Expression too long (max 500 characters)");
  }

  const safeRegex = /^[\d+\-*/%().\s\w]+$/;
  if (!safeRegex.test(expression)) {
    return failedResult(
      ExecutionErrorCode.INVALID_PARAM,
      "Expression contains disallowed characters. Allowed: digits, + - * / % ** ( ) . math functions",
    );
  }

  try {
    const mathContext = {
      sqrt: Math.sqrt,
      abs: Math.abs,
      round: Math.round,
      floor: Math.floor,
      ceil: Math.ceil,
      sin: Math.sin,
      cos: Math.cos,
      tan: Math.tan,
      log: Math.log,
      log10: Math.log10,
      exp: Math.exp,
      pow: Math.pow,
      PI: Math.PI,
      E: Math.E,
    };

    const fnValues = Object.values(mathContext);

    const safeEval = new Function(
      ...Object.keys(mathContext),
      `"use strict"; return (${expression});`,
    );

    const result = safeEval(...fnValues);

    if (typeof result !== "number" || !isFinite(result)) {
      return failedResult(ExecutionErrorCode.EXECUTION_ERROR, `Result is not a finite number (got: ${result})`);
    }

    const formatted = Number.isInteger(result)
      ? String(result)
      : parseFloat(result.toPrecision(12)).toString();

    return successResult(formatted);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return failedResult(ExecutionErrorCode.EXECUTION_ERROR, `Error evaluating expression: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// 3. web_search — real web search via Tavily API
// ---------------------------------------------------------------------------

const webSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current, real-time information. Use this when the user asks about recent events, news, facts you're unsure about, or information that may not be in your training data. Returns actual search results from the web.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "The search query string — be specific and include relevant keywords.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (1-10, default 5).",
        },
      },
      required: ["query"],
    },
  },
};

async function webSearchExecute(
  args: Record<string, unknown>,
  context: RunContext,
): Promise<ExecutionResult> {
  const query = (args.query as string) || "";
  const maxResults = Math.min(
    Math.max(1, (args.max_results as number) || 5),
    10,
  );

  if (!query.trim()) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, "Empty search query");
  }

  const apiKey =
    process.env.TAVILY_API_KEY || process.env.SERPAPI_API_KEY || "";

  if (!apiKey) {
    return partialResult(
      JSON.stringify({
        note: "Web search API key not configured. Set TAVILY_API_KEY or SERPAPI_API_KEY in .env. Results below are simulated.",
        query,
        results: [
          {
            title: `Search results for: ${query}`,
            snippet: `Real web search requires a Tavily API key (free tier available at https://tavily.com). Set TAVILY_API_KEY in your .env file to enable.`,
            url: "https://tavily.com",
          },
        ],
      }),
      "API key not configured, using simulated results",
    );
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: "basic",
        include_answer: true,
      }),
      signal: context.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Tavily API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as {
      answer?: string;
      results?: Array<{
        title: string;
        url: string;
        content: string;
        score: number;
      }>;
    };

    const results = (data.results || []).slice(0, maxResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content.slice(0, 300),
      score: r.score,
    }));

    return successResult(JSON.stringify({
      query,
      answer: data.answer || null,
      results,
      total: results.length,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return failedResult(
      ExecutionErrorCode.API_ERROR,
      `Web search failed: ${msg}`,
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. http_request — make HTTP requests to external APIs
// ---------------------------------------------------------------------------

const httpRequestDef: ToolDefinition = {
  type: "function",
  function: {
    name: "http_request",
    description:
      "Make an HTTP request to an external URL. Use this to fetch data from APIs, check website status, or retrieve remote content. Supports GET and POST methods. Results are truncated to 5000 characters.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "The full URL to request (must start with http:// or https://).",
        },
        method: {
          type: "string",
          description: "HTTP method: GET or POST. Defaults to GET.",
          enum: ["GET", "POST"],
        },
        body: {
          type: "string",
          description: "Request body as JSON string (only for POST requests).",
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers as key-value pairs.",
        },
      },
      required: ["url"],
    },
  },
};

async function httpRequestExecute(
  args: Record<string, unknown>,
  context: RunContext,
): Promise<ExecutionResult> {
  const url = (args.url as string) || "";
  const method = ((args.method as string) || "GET").toUpperCase();
  const body = args.body as string | undefined;
  const headers = (args.headers as Record<string, string>) || {};

  if (!url) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, "URL is required");
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return failedResult(ExecutionErrorCode.INVALID_PARAM, "URL must start with http:// or https://");
  }

  try {
    const fetchOptions: RequestInit = {
      method,
      headers: {
        "User-Agent": "AgentForge/1.0",
        Accept: "application/json, text/plain, */*",
        ...headers,
      },
      signal: context.signal,
    };

    if (method === "POST" && body) {
      (fetchOptions.headers as Record<string, string>)["Content-Type"] =
        "application/json";
      fetchOptions.body = body;
    }

    const response = await fetch(url, fetchOptions);

    const contentType = response.headers.get("content-type") || "";
    let responseBody: string;

    if (contentType.includes("application/json")) {
      const json = await response.json();
      responseBody = JSON.stringify(json);
    } else {
      responseBody = await response.text();
    }

    // Truncate large responses
    const truncated =
      responseBody.length > 5000
        ? responseBody.slice(0, 5000) + "... (truncated)"
        : responseBody;

    const output = JSON.stringify({
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: truncated,
    });

    if (responseBody.length > 5000) {
      return partialResult(output, "Response body truncated to 5000 characters");
    }

    return successResult(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return failedResult(
      ExecutionErrorCode.NETWORK_ERROR,
      `HTTP request failed: ${msg}`,
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Export all built-in tools with risk levels and timeouts
// ---------------------------------------------------------------------------

export const builtinTools: RegisteredTool[] = [
  {
    definition: getCurrentTimeDef,
    execute: getCurrentTimeExecute,
    riskLevel: "safe",
    timeout: 5_000,
    requireApproval: false,
    category: "utility",
    parallelizable: true,
  },
  {
    definition: calculatorDef,
    execute: calculatorExecute,
    riskLevel: "safe",
    timeout: 5_000,
    requireApproval: false,
    category: "utility",
    parallelizable: true,
  },
  {
    definition: webSearchDef,
    execute: webSearchExecute,
    riskLevel: "read_only",
    timeout: 15_000,
    requireApproval: false,
    category: "search",
    parallelizable: true,
  },
  {
    definition: httpRequestDef,
    execute: httpRequestExecute,
    riskLevel: "mutation",
    timeout: 20_000,
    requireApproval: false,
    category: "network",
    parallelizable: false,
  },
];
