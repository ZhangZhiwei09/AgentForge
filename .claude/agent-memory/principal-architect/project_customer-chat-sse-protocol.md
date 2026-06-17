---
name: customer-chat-sse-protocol
description: Customer chat SSE chunk types and data flow architecture
metadata:
  type: project
---

The customer-chat SSE stream uses `RouteStreamEvent` (defined in `apps/server/src/services/agent-runtime/types.ts`) with 5 chunk types: `meta`, `token`, `done`, `content_block`, `error`. The stream is produced by `AgentRuntimeService.streamChat()` and emitted via `POST /api/agent/chat` route handler.

Frontend handles `tool_call` and `tool_result` types that are NOT in the server-side `RouteStreamEvent` union — these are dead code in the customer-chat context.

**Why:** Understanding the actual SSE protocol is essential before modifying any type boundaries. The `tool_call`/`tool_result` handlers are vestigial and should be removed during type safety refactoring.

**How to apply:** When touching SSE parsing in CustomerChat.tsx or useCustomerChatStream.ts, only handle the 5 RouteStreamEvent types. When the server adds tool calling support, update RouteStreamEvent type first, then sync frontend.
