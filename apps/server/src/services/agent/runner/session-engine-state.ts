// Session Engine State — Persist and read the engine type bound to a session.
//
// Engine stickiness is a hard requirement: once a session is created with an engine,
// all subsequent resume/approval calls MUST use the same engine. This module provides
// the low-level read/write primitives.
//
// Phase 1: Engine is always "legacy". Storage is in-memory only (no runtime_state yet).
// Phase 2: Stores engine in agent_sessions.runtime_state JSON alongside LangGraph checkpoint.
//          Uses the CheckpointAdapter / session-persistence module for durable reads.

import type { AgentEngine } from "./types.js";
import { logger } from "@agentforge/logger";

// ── In-Memory Store (Phase 1) ─────────────────────────
// Replaced by runtime_state column in Phase 2.

const engineStore = new Map<string, AgentEngine>();

// ── Public API ────────────────────────────────────────

/**
 * Record which engine is bound to a session. Called at session creation time.
 */
export function recordSessionEngine(
  sessionId: string,
  engine: AgentEngine,
): void {
  engineStore.set(sessionId, engine);
  logger.debug({ sessionId, engine }, "Session engine recorded");
}

/**
 * Read the engine bound to a session. Returns null if no record exists
 * (implies legacy, since only langgraph sessions need explicit tracking
 * once runtime_state is in place).
 */
export function getSessionEngine(sessionId: string): AgentEngine | null {
  return engineStore.get(sessionId) ?? null;
}

/**
 * Clear engine record — used when a session is completed/failed.
 */
export function clearSessionEngine(sessionId: string): void {
  engineStore.delete(sessionId);
}
