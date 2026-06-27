// RunnerSelector — Determines which agent engine handles a request.
//
// Phase 1: Always returns "legacy".
// Phase 3: Checks per-caller rollout config and session stickiness.
//   - New sessions: caller-level engine flag (env / feature flag / db config)
//   - Existing sessions: engine stored at session creation (sticky)
//
// Session stickiness is non-negotiable: once a session is created with an engine,
// all resume/approval calls for that session MUST use the same engine.

import type { AgentEngine } from "./types.js";

export interface SelectorContext {
  /** Caller identity for per-caller rollout (e.g. "agent-executor", "workflow-agent-step") */
  caller?: string;
  /** If the session already exists, the engine it was created with (sticky) */
  sessionEngine?: AgentEngine | null;
  /** Whether to force legacy (rollback switch) */
  forceLegacy?: boolean;
}

export class RunnerSelector {
  /**
   * Select the engine for a given request.
   *
   * Phase 1: Always returns "legacy" — no langgraph engine exists yet.
   *
   * Selection priority (Phase 3):
   * 1. forceLegacy flag (rollback override)
   * 2. Existing session engine (stickiness — must not drift)
   * 3. Per-caller rollout config
   * 4. Default: "legacy"
   */
  select(context: SelectorContext = {}): AgentEngine {
    // Rollback override — highest priority
    if (context.forceLegacy) {
      return "legacy";
    }

    // Session stickiness — if session already has an engine, honor it
    if (context.sessionEngine) {
      return context.sessionEngine;
    }

    // Phase 1: Always legacy. Phase 3: Check per-caller config.
    return "legacy";
  }
}
