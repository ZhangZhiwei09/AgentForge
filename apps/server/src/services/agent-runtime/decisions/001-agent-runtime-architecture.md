# ADR 001: Agent Runtime Architecture

**Date:** 2026-06-16

**Status:** Accepted

## Context

The `customer-chat` module was originally built as an e-commerce logistics customer service demo (fake order data + shipping tools + video chat). Its architectural core — ToolRegistry, ReAct Agent, Citation Pipeline, ContentBlock, SSE Streaming — was already an Agent Runtime prototype.

The decision was to elevate the domain model from "Customer Service" to "Agent Runtime", enabling the same runtime to serve: e-commerce support, government Q&A, IT helpdesk, DevOps assistant, HR assistant, and any knowledge + tool-driven agent scenario.

## Decision

Rename `customer-chat` → `agent-runtime` and restructure the architecture:

1. **4-Route Classifier** (SAFETY / CHAT / TASK / HUMAN) — Rule-First + LLM Fallback
2. **Unified AgentExecutor** — single ReAct executor for all TASK scenarios
3. **Tool Layering** — Builtin (search_knowledge_base) vs Business (per-scenario tools)
4. **KnowledgeContext Layer** — structured context between tool output and Agent reasoning
5. **ContentBlock Protocol** — rich media output channel (text, table, action cards)

## Consequences

- Router no longer recommends tool lists — Agent chooses tools autonomously in ReAct loop
- `create_support_ticket` moved from builtin to Business layer
- Old e-commerce tools (lookup_order, check_shipping_status, check_return_policy) removed
- Video chat components removed (separate V11 video feature remains)
- Frontend simplified: no dashboard, no order/status/policy cards
- Conversation type changed from `customer_service` to `agent_chat`
- All metrics renamed from `cs_*` to `agent_*`
- Old ADR documents (001-004) retired

## Alternatives Considered

1. **Keep KNOWLEDGE / ACTION split** — rejected because "check error rate in payment system" needs both KB and tools, making intent-based splitting impossible
2. **Keep customer-chat name** — rejected because it limits the perceived scope
3. **Split agent-executor into knowledge-agent.ts and action-agent.ts** — rejected because both share identical ReAct loop, Tool Calling, Memory, Validation, and SSE Streaming logic

## Related

- `docs/agent-runtime-refactor-plan.md` — detailed implementation plan
- ToolRegistry (`tools/registry.ts`) — category-based tool querying
- KnowledgeContextBuilder (`services/agent-runtime/knowledge-context.ts`)
