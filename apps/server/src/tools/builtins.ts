// Built-in tools for V4 Tool Calling
// Each tool exports its definition and executor function
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";

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
): Promise<string> {
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
    return formatter.format(now);
  } catch {
    // Invalid timezone — fall back to UTC
    const now = new Date();
    return `Invalid timezone "${timezone}". Current UTC time: ${now.toISOString()}`;
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
): Promise<string> {
  const expression = (args.expression as string) || "";

  // Sanitize and validate the expression
  if (!expression.trim()) {
    return "Error: empty expression";
  }
  if (expression.length > 500) {
    return "Error: expression too long (max 500 characters)";
  }

  // Only allow safe characters: digits, operators, parens, dots, whitespace,
  // and function names (letters)
  const safeRegex = /^[\d+\-*/%().\s\w]+$/;
  if (!safeRegex.test(expression)) {
    return `Error: expression contains disallowed characters. Allowed: digits, + - * / % ** ( ) . math functions`;
  }

  try {
    // Replace ** with a custom token, restore after eval
    // Use Function constructor as a safer alternative to eval
    // Provide common math functions
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

    const fnNames = Object.keys(mathContext).join(", ");
    const fnValues = Object.values(mathContext);

    // We use Function constructor with explicit bindings for math functions
    const safeEval = new Function(
      ...Object.keys(mathContext),
      `"use strict"; return (${expression});`,
    );

    const result = safeEval(...fnValues);

    if (typeof result !== "number" || !isFinite(result)) {
      return `Error: result is not a finite number (got: ${result})`;
    }

    // Format the result — trim trailing zeros for nice display
    const formatted =
      Number.isInteger(result) ? String(result) : parseFloat(result.toPrecision(12)).toString();

    return formatted;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return `Error evaluating expression: ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// 3. web_search — stub for future real web search integration
// ---------------------------------------------------------------------------

const webSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the web for current information. Use this when the user asks about recent events, news, or information that may not be in your training data. Currently returns simulated results.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query string",
        },
      },
      required: ["query"],
    },
  },
};

async function webSearchExecute(
  args: Record<string, unknown>,
): Promise<string> {
  const query = (args.query as string) || "";
  if (!query.trim()) return "Error: empty search query";

  // Stub: return a note that web search isn't fully implemented yet
  return JSON.stringify({
    note: "Web search is not yet integrated with a real search API. Results below are simulated.",
    query,
    results: [
      {
        title: `Search results for: ${query}`,
        snippet: `This is a placeholder for real web search results about "${query}". Real search integration coming in a future update.`,
        url: "https://example.com/stub",
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Export all built-in tools
// ---------------------------------------------------------------------------

export const builtinTools: RegisteredTool[] = [
  { definition: getCurrentTimeDef, execute: getCurrentTimeExecute },
  { definition: calculatorDef, execute: calculatorExecute },
  { definition: webSearchDef, execute: webSearchExecute },
];
