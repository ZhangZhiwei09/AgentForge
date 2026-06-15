// Network tools — web_fetch for URL content retrieval
import type { ToolDefinition } from "@agentforge/shared-types";
import type { RegisteredTool } from "./types.js";
import type { RunContext } from "../runtime/context.js";
import { logger } from "@agentforge/logger";

// Tool definition for web_fetch
const webFetchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "web_fetch",
    description:
      "Fetch the content of a web page or URL and return it as text. Useful for reading documentation, articles, or any web content. Returns the response body along with status and content-type metadata.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch. Must start with http:// or https://.",
        },
        max_chars: {
          type: "number",
          description:
            "Maximum number of characters to return from the response body. Default 10000, maximum 50000.",
        },
      },
      required: ["url"],
    },
  },
};

async function webFetchExecute(
  args: Record<string, unknown>,
  context: RunContext,
): Promise<string> {
  const url = (args.url as string) || "";
  const maxChars = Math.min((args.max_chars as number) || 10_000, 50_000);

  // Validate URL
  if (!/^https?:\/\/.+/i.test(url)) {
    return `Error: Invalid URL "${url}". URL must start with http:// or https://.`;
  }

  const start = Date.now();

  // Registry already handles timeout + cancellation via executeWithTimeout;
  // use context.signal directly to avoid redundant timeout signal allocation.
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "AgentForge/1.0",
        Accept: "text/html, text/plain, application/json, */*",
      },
      signal: context.signal,
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "unknown";
    const status = response.status;

    if (!response.ok) {
      return `Error: HTTP ${status} — ${response.statusText} for URL "${url}"`;
    }

    const rawBody = await response.text();
    const bodyLength = rawBody.length;
    const truncated = rawBody.slice(0, maxChars);
    const duration = Date.now() - start;

    logger.info(
      {
        url,
        status,
        bodyLength,
        returnedChars: truncated.length,
        durationMs: duration,
      },
      "web_fetch executed",
    );

    return JSON.stringify(
      {
        url,
        status,
        content_type: contentType,
        content_length: bodyLength,
        returned_chars: truncated.length,
        truncated: bodyLength > maxChars,
        content: truncated,
        duration_ms: duration,
      },
      null,
      2,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";

    if ((err as Error)?.name === "AbortError") {
      logger.warn({ url }, "web_fetch timed out");
      return `Error: Request timed out for URL "${url}" (15s timeout)`;
    }

    logger.error({ url, error: msg }, "web_fetch failed");
    return `Error fetching URL "${url}": ${msg}`;
  }
}

export const networkTools: RegisteredTool[] = [
  {
    definition: webFetchDef,
    execute: webFetchExecute,
    riskLevel: "read_only",
    timeout: 20_000,
    requireApproval: false,
    category: "network",
    parallelizable: true,
  },
];
