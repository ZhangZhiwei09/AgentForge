---
name: codegen-file-splitting
description: codegen.ts (642 lines) split into services/codegen/ directory with 6 sub-modules + barrel re-export
metadata:
  type: project
---

# codegen.ts File Splitting

**Date:** 2026-06-16
**Status:** Complete

**Split:** `services/codegen.ts` (642 lines) → `services/codegen/` directory with:
- `prompts.ts` — all PROMPT constants, MAX_TOKENS constants, LANG_GUIDES map
- `llm.ts` — `callLLM()` function + `CodeGenLLMCaller` type alias
- `plan.ts` — `planAppStructure`, `extractFilePlan`, `detectLang`, `getDefaultPlan`
- `generate.ts` — `generateFile`, `extractFileContent`
- `review.ts` — `reviewApp`
- `index.ts` — `CodeGenService` class (thin orchestration) + `codeGenService` singleton

**Key pattern:** `services/codegen.ts` barrel (3 lines) re-exports from `./codegen/index.js`. This preserves the `import { codeGenService } from "../services/codegen.js"` in `routes/app-project.ts` — TypeScript `moduleResolution: "bundler"` resolves `codegen.js` → `codegen.ts` (file), not `codegen/index.ts`.

**Dependency injection:** `plan.ts`, `generate.ts`, `review.ts` receive `callLLM: CodeGenLLMCaller` as parameter (avoids circular imports). `review.ts` also receives `getFiles` function. `generate.ts` also receives `langGuides`.

**Dynamic import preserved:** `getProjectName()` keeps `await import("../../db.js")` (Phase 5 will fix).
