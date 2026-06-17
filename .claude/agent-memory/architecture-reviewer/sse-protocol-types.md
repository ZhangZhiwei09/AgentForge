---
name: sse-protocol-types
description: Backend SSE event type contracts and the gap between RouteStreamEvent and frontend expectations
metadata:
  type: reference
---

Backend SSE protocol for customer-chat/agent-chat:

- `RouteStreamEvent` (in `apps/server/src/services/agent-runtime/types.ts`): 5 types — `meta | token | done | content_block | error`
- `StreamChunk` (in `apps/server/src/providers/types.ts`): 3 types — `token | tool_call | done`
- Provider-level `StreamChunk` is consumed internally by AgentService and mapped to AgentStreamEvent/RouteStreamEvent
- Frontend (CustomerChat.tsx, useCustomerChatStream.ts) handles `tool_call` and `tool_result` — these are defined in `shared-types/src/tool.ts` as `ToolCallChunk`/`ToolResultChunk` but are NOT in `RouteStreamEvent`
- `/api/customer-chat` does NOT exist as a server route; actual endpoint is `/api/agent/chat`
- `AgentRuntimeService.streamChat()` has return type `AsyncGenerator<Record<string, unknown>>` — a type hole in the backend itself
