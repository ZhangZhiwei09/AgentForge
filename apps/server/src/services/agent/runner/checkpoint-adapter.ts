// CheckpointAdapter — Durable checkpoint persistence for LangGraph.
//
// Per langchain-langgraph-refactor-plan.md §10.3:
//   - CheckpointAdapter is the interface between LangGraph's Checkpointer and
//     AgentForge's persistence layer (agent_sessions.runtime_state).
//   - It does NOT import PrismaClient directly — it operates through the
//     session-persistence module's restricted interface.
//   - The adapter is responsible for serializing/deserializing LangGraph
//     CheckpointTuple ↔ agent_sessions.runtime_state JSON.
//
// Phase 1: Interface definition + skeleton. Real implementation in Phase 2
//          alongside LangGraphAgentRunner.

import type { AgentEngine } from "./types.js";

// ── LangGraph Checkpoint Types (mirrors @langchain/langgraph CheckpointTuple) ─

/** Serialized LangGraph checkpoint — stored in runtime_state.checkpoint */
export interface RuntimeStateCheckpoint {
  /** LangGraph checkpoint_id — serves as resumeCursor */
  checkpoint_id: string;
  /** Channel values (graph state at checkpoint) */
  channel_values: Record<string, unknown>;
  /** Channel versions (for conflict detection) */
  channel_versions: Record<string, number>;
  /** Pending sends (interrupts waiting for resume) */
  pending_sends: Array<unknown>;
  /** Which node to resume from (for interrupt recovery) */
  next_nodes?: string[];
  /** Timestamp when checkpoint was created */
  created_at: string;
}

/** The complete runtime_state JSON structure stored in agent_sessions.runtime_state */
export interface RuntimeStateBlob {
  /** Engine metadata */
  engine: AgentEngine;
  /** Schema version for checkpoint compatibility (§10.7) */
  version: number;
  /** When the engine was first bound to this session */
  engine_bound_at: string;
  /** The LangGraph checkpoint data (null when session is not paused) */
  checkpoint: RuntimeStateCheckpoint | null;
  /** Extra engine-specific metadata */
  metadata?: Record<string, unknown>;
}

// ── CheckpointAdapter Interface ────────────────────────

export interface CheckpointAdapter {
  /**
   * Load the runtime_state blob for a session.
   * Returns null if no runtime_state exists (legacy session or new session).
   */
  get(sessionId: string): Promise<RuntimeStateBlob | null>;

  /**
   * Persist the runtime_state blob for a session.
   * Called after each graph node transition when using LangGraph engine.
   */
  put(sessionId: string, state: RuntimeStateBlob): Promise<void>;

  /**
   * Clear runtime_state for a session (used when session completes/fails).
   */
  delete(sessionId: string): Promise<void>;

  /**
   * List all sessions that have runtime_state (for recovery/audit).
   */
  list(conversationId: string): Promise<Array<{ sessionId: string; engine: AgentEngine; version: number }>>;
}

// ── Version Compatibility ──────────────────────────────

/** Current runtime_state schema version. Increment on incompatible changes. */
export const RUNTIME_STATE_VERSION = 1;

/**
 * Check if a runtime_state version is compatible with the current engine.
 * Per §10.7: incompatible versions force fallback to legacy engine.
 */
export function isRuntimeStateCompatible(blob: RuntimeStateBlob): boolean {
  // Phase 1: Only version 1 exists. Future versions add compatibility rules.
  return blob.version === RUNTIME_STATE_VERSION;
}

// ── PrismaCheckpointer (Phase 2 skeleton) ──────────────

/**
 * Prisma-backed implementation of CheckpointAdapter.
 *
 * Phase 2 will implement this using session-persistence module's restricted
 * interface. It serializes LangGraph CheckpointTuple to RuntimeStateBlob
 * and persists it via agent_sessions.runtime_state.
 *
 * Constructor takes a restricted persistence handle — it does NOT import
 * PrismaClient directly (per Constraint 7).
 */
export class PrismaCheckpointer implements CheckpointAdapter {
  // Phase 2: constructor receives a restricted persistence handle

  async get(_sessionId: string): Promise<RuntimeStateBlob | null> {
    // Phase 2: read from session-persistence.getSession() → runtimeState
    throw new Error("PrismaCheckpointer.get not implemented in Phase 1");
  }

  async put(_sessionId: string, _state: RuntimeStateBlob): Promise<void> {
    // Phase 2: write via session-persistence restricted update
    throw new Error("PrismaCheckpointer.put not implemented in Phase 1");
  }

  async delete(_sessionId: string): Promise<void> {
    // Phase 2: set runtime_state to null via session-persistence
    throw new Error("PrismaCheckpointer.delete not implemented in Phase 1");
  }

  async list(_conversationId: string): Promise<Array<{ sessionId: string; engine: AgentEngine; version: number }>> {
    // Phase 2: query sessions with non-null runtime_state
    throw new Error("PrismaCheckpointer.list not implemented in Phase 1");
  }
}
