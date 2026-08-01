# Chinese Prompts Rule

All LLM-facing text must be written in **Chinese**, not English.

## Scope

This rule applies to any text that will be sent to an LLM:

- System prompts
- ReAct prompts
- Tool descriptions (`description` field in ToolDefinition)
- Context builder templates
- Error messages yielded to the model
- Any future prompt templates

## Affected Files

| File | Content |
|---|---|
| `packages/shared-prompts/src/index.ts` | All `Prompt.content` strings |
| `apps/server/src/services/agent.ts` | `buildIterationContext` template strings |
| `apps/server/src/tools/builtins.ts` | Tool `description` fields |
| `apps/server/src/tools/file-tools.ts` | Tool `description` fields |

## Rationale

The user explicitly requested all prompts be in Chinese. English prompts were initially written into the system and have been progressively migrated to Chinese.

## Enforcement

When writing or modifying any LLM-facing string:

1. Write it in Chinese by default.
2. If an English string is necessary (e.g., technical terms without good translations), justify in comments.
3. During code review, flag English strings in prompt/tool-description contexts as P1.
