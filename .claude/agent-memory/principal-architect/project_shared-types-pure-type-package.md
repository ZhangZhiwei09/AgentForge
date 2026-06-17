---
name: shared-types-pure-type-package
description: shared-types package currently has zero runtime dependencies
metadata:
  type: project
---

`packages/shared-types` is currently a pure TypeScript type package with no runtime dependencies. Its `package.json` only has `typescript` in `devDependencies`. Adding Zod schemas would be the first runtime dependency, changing the nature of this package.

**Why:** Any decision to add runtime code to shared-types must be considered against the simplicity and tree-shaking implications of a type-only package. The customer-chat type safety design proposes adding `zod` as a dependency — this is a deliberate architectural tradeoff.

**How to apply:** Before adding any runtime dependency to shared-types, verify: (1) the schema serves both client and server, (2) the dependency supports ESM tree-shaking, (3) the benefit of single source of truth outweighs the package complexity increase.
