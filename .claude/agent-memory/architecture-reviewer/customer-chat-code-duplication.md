---
name: customer-chat-code-duplication
description: CustomerChat.tsx and useCustomerChatStream.ts have ~90% duplicate SSE parsing logic
metadata:
  type: reference
---

`apps/web/src/components/customer-chat/CustomerChat.tsx` and `apps/web/src/hooks/useCustomerChatStream.ts`:
- Both contain nearly identical SSE stream reading, line parsing, chunk type dispatch (~150 lines each)
- CustomerChat.tsx implements SSE handling directly in the component
- useCustomerChatStream.ts implements it as a custom hook
- Before any type safety refactoring, the duplicate logic should be consolidated into one shared implementation
