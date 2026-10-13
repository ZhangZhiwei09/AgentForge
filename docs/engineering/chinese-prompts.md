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
| `apps/server-py/src/agent/context_builder.py` | Shared runtime context and system prompt |
| `apps/server-py/src/agent/executor.py` | ReAct system prompt |
| `apps/server-py/src/agent/router/business_classifier.py` | Business classification prompt |
| `apps/server-py/src/agent/diagnosis/` | Diagnosis prompts and model context |
| `apps/server-py/src/agent/tools/` | Tool descriptions and model-facing results |
| `apps/server-py/src/services/chat_tasks.py` | Consultation and task context |

## Rationale

The user explicitly requested all prompts be in Chinese. English prompts were initially written into the system and have been progressively migrated to Chinese.

## Enforcement

When writing or modifying any LLM-facing string:

1. Write it in Chinese by default.
2. If an English string is necessary (e.g., technical terms without good translations), justify in comments.
3. During code review, flag English strings in prompt/tool-description contexts as P1.
