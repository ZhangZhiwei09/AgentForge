---
name: architecture_react-ask-user-handling-gap
description: AgentExecutor doesn't handle agent_ask_user events, causing ReAct JSON leakage to users
metadata:
  type: project
---

# ReAct Agent ask_user Event Handling Gap

**Discovered**: 2026-06-19

## The Gap

AgentService (ReAct loop) emits `agent_ask_user` when LLM decides `decision.action === "ask_user"`. However, AgentExecutor (the TASK route handler that wraps AgentService) doesn't handle this event in its switch statement — it falls to `default: break`, the stream ends, and post-processing kicks in with `sanitizeReActJSON` which doesn't extract `decision.question` for ask_user decisions.

**Result**: User sees internal ReAct JSON (observation/analysis/plan) instead of a proper natural-language question.

## Two-Layer Event System

- **AgentStreamEvent** (inner layer): AgentService → AgentExecutor. Has `agent_ask_user` event type.
- **RouteStreamEvent** (outer layer): AgentExecutor → SSE → Frontend. Does NOT have a corresponding "clarify" event type.

## Key Files
- AgentService: `apps/server/src/services/agent/index.ts` (lines 854-872, yields agent_ask_user)
- AgentExecutor: `apps/server/src/services/agent-runtime/agent-executor.ts` (missing case in switch at lines 141-228)
- sanitizeReActJSON: `apps/server/src/services/agent-runtime/agent-executor.ts` (lines 431-477, misses decision.question)
- RouteStreamEvent types: `apps/server/src/services/agent-runtime/types.ts`
- Frontend: `apps/web/src/hooks/useAgentStream.ts` (ask_user explicitly not implemented)

**How to apply**: When touching AgentExecutor event handling or adding new AgentService events, ensure dual-layer mapping is complete.
