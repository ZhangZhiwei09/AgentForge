---
name: shared-types-no-zod
description: shared-types package is a pure type-definition package with no runtime dependencies (no Zod)
metadata:
  type: reference
---

`packages/shared-types`:
- Only devDependency: `typescript`
- Exports ONLY `type` (no runtime values, no Zod schemas)
- Zod is used in `apps/server` (routes, validation, chat-agent, agent-executor)
- Any proposal to add Zod to shared-types would change it from pure-type to runtime-validation package
- Consider alternative: `packages/shared-schemas` or inline schemas in `apps/web`
