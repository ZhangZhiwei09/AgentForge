// Content safety middleware — detects prompt injection attempts and enforces content policies
// Applied specifically to Chat and Agent routes to prevent LLM prompt manipulation
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../app.js";
import { logger } from "@agentforge/logger";

// Common prompt injection patterns
const INJECTION_PATTERNS = [
  // Direct system prompt override attempts
  /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|above|prior)\s+instructions?/i,
  /forget\s+(all\s+)?(previous|earlier|prior)\s+instructions?/i,
  /you\s+are\s+now\s+(a\s+)?different/i,
  /new\s+system\s+prompt/i,
  /override\s+system/i,

  // System prompt extraction attempts
  /reveal\s+(your|the)\s+(system\s+)?prompt/i,
  /show\s+me\s+(your|the)\s+(system\s+)?prompt/i,
  /what\s+(is|are)\s+(your|the)\s+(system\s+)?prompt/i,
  /print\s+(your|the)\s+(system\s+)?instructions/i,
  /dump\s+(your|the)\s+(system\s+)?prompt/i,

  // Role manipulation
  /^\s*system\s*:\s*/im,
  /\[system\]/i,
  /<system>/i,
  /<\|system\|>/i,
  /\[INST\]/,

  // Jailbreak attempts
  /DAN\s+mode/i,
  /developer\s+mode/i,
  /jailbreak/i,
  /pretend\s+you\s+are/i,
  /act\s+as\s+if/i,

  // Token smuggling
  /ignore\s+the\s+above/i,
  /disregard\s+everything\s+(above|before)/i,
];

// Maximum allowed message length
const MAX_CONTENT_LENGTH = 16000;

export interface ContentSafetyResult {
  safe: boolean;
  reason?: string;
  sanitized?: string;
}

export function checkContentSafety(content: string): ContentSafetyResult {
  // Check length
  if (content.length > MAX_CONTENT_LENGTH) {
    return {
      safe: false,
      reason: `Message too long (${content.length} chars). Maximum is ${MAX_CONTENT_LENGTH} characters.`,
    };
  }

  // Check for empty content
  if (!content.trim()) {
    return { safe: false, reason: "Message is empty" };
  }

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      logger.warn(
        { pattern: pattern.source, contentPreview: content.slice(0, 100) },
        "Prompt injection detected",
      );
      return {
        safe: false,
        reason: "Content violates safety policy",
      };
    }
  }

  return { safe: true };
}

// Middleware that validates request body for chat/agent endpoints
export const contentSafetyMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  // Only apply to POST endpoints that accept user messages
  const isChatOrAgent =
    c.req.path === "/api/chat" ||
    c.req.path === "/api/agent/run" ||
    c.req.path === "/api/agent/respond";

  if (!isChatOrAgent || c.req.method !== "POST") {
    return next();
  }

  // Try to parse and check the body
  // Clone the request before reading — Hono request bodies are single-consumption
  // ReadableStreams. Without cloning, downstream route handlers get an empty body.
  try {
    const cloned = c.req.raw.clone();
    const body = await cloned.json().catch(() => null);
    if (!body) return next();

    const message = body.message || body.task || "";
    const check = checkContentSafety(message);

    if (!check.safe) {
      return c.json({ detail: check.reason }, 400);
    }
  } catch {
    // If we can't parse the body, let the route handler deal with it
  }

  await next();
};
