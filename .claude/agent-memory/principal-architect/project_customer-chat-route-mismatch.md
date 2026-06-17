---
name: customer-chat-route-mismatch
description: Frontend calls /api/customer-chat but server only has /api/agent/chat
metadata:
  type: project
---

Frontend files `CustomerChat.tsx` and `useCustomerChatStream.ts` both call `fetch("/api/customer-chat")` but the server only defines `POST /api/agent/chat`. The `contentSafetyMiddleware` intercepts `/api/customer-chat` but there is no route handler — requests would return 404. This routing mismatch is a bug that should be fixed independently or alongside the type safety work.

**Why:** This was discovered during the type safety audit and represents a functional bug separate from type safety concerns. Fixing it requires either adding a `/api/customer-chat` alias route or updating frontend URLs to `/api/agent/chat`.

**How to apply:** When fixing, prefer updating frontend URLs to `/api/agent/chat` (single source of truth) over adding an alias route. The FAQ endpoints use `/api/agent/chat/faq` correctly. Verify Vite proxy forwards all `/api/*` paths.
