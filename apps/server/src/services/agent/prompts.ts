// Prompts and context construction for AgentService ReAct loop
import type { AgentStep, ToolDefinition } from "@agentforge/shared-types";
import { react_system_prompt } from "@agentforge/shared-prompts";

// Maximum iterations to prevent infinite loops
export const DEFAULT_MAX_ITERATIONS = 10;

// Timeout per LLM call (ms)
export const ITERATION_TIMEOUT_MS = 120_000;

// Virtual tool: agent_decide — the LLM calls this to report its decision
// instead of outputting raw JSON. Provides native structured output guarantee.
export const AGENT_DECIDE_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "agent_decide",
    description:
      "Report your observation, analysis, plan, and decision for this step. " +
      "Call this function instead of outputting JSON text.",
    parameters: {
      type: "object",
      properties: {
        observation: {
          type: "string",
          description:
            "What I observe about the current state and available information",
        },
        analysis: {
          type: "string",
          description:
            "What this means — interpretation and progress assessment",
        },
        plan: {
          type: "string",
          description: "What to do next and why",
        },
        action: {
          type: "string",
          enum: ["tool_call", "respond", "ask_user"],
          description: "The type of action to take",
        },
        tool: {
          type: "string",
          description:
            "Name of the tool to call (required if action=tool_call)",
        },
        args_json: {
          type: "string",
          description:
            "JSON-encoded tool arguments (required if action=tool_call)",
        },
        reason: {
          type: "string",
          description: "Why this tool is needed (required if action=tool_call)",
        },
        content: {
          type: "string",
          description:
            "The final response to the user (required if action=respond)",
        },
        summary: {
          type: "string",
          description:
            "One-line summary of what was accomplished (required if action=respond)",
        },
        question: {
          type: "string",
          description:
            "The question to ask the user (required if action=ask_user)",
        },
        clarify_context: {
          type: "string",
          description:
            "Why this clarification is needed (required if action=ask_user)",
        },
      },
      required: ["observation", "analysis", "plan", "action"],
    },
  },
};

// ReAct prompt adapted for tool calling — instructs LLM to call agent_decide
export const REACT_PROMPT_WITH_TOOLS =
  react_system_prompt.content +
  "\n\n重要：你必须调用 agent_decide 函数来报告你的决策，而不是输出原始 JSON 文本。" +
  "\n\n注意：不要输出 ```card:xxx 格式的围栏代码块。系统会自动从工具返回的数据中提取结构化卡片展示给用户。" +
  "\n你只需用自然语言 + Markdown 格式（表格、列表等）向用户解释结果即可。";

/**
 * System prompt for respond-only mode — instructs LLM to output clean Markdown
 * after tool results have been fed back.
 */
export function getRespondOnlySystemPrompt(): string {
  return (
    "你是一个乐于助人的 AI 客服助手。请根据上面的工具返回数据，用中文直接回复用户。" +
    "\n使用 Markdown 格式组织回答（表格、列表等），简洁专业。" +
    "\n不要输出 JSON 结构或代码围栏，只输出给用户看的自然语言内容。"
  );
}

/**
 * Build the full context for an iteration: system prompt + task + scratchpad.
 */
export function buildIterationContext(
  systemPrompt: string,
  task: string,
  scratchpad: AgentStep[],
  currentStep: number,
  compressedSummary?: string,
  keptStepNumbers?: Set<number>,
  respondOnly: boolean = false,
): string {
  const parts = [systemPrompt];

  parts.push(`\n\n## 当前任务\n${task}`);

  if (scratchpad.length > 0) {
    // P0-3: If compression has occurred, show summary + kept steps only
    if (compressedSummary && keptStepNumbers) {
      parts.push(
        `\n\n## 历史步骤摘要`,
        compressedSummary,
        `\n\n## 保留的关键步骤`,
      );
      const keptSteps = scratchpad.filter((s) => keptStepNumbers.has(s.step));
      for (const step of keptSteps) {
        parts.push(formatStepForContext(step));
      }
      parts.push(
        `\n注意：以上为压缩后的关键步骤，完整记录已保存但未在上下文中展示。`,
      );
    } else {
      parts.push(
        `\n\n## 历史步骤（Scratchpad）\n你已完成 ${scratchpad.length} 步：`,
      );
      for (const step of scratchpad) {
        parts.push(formatStepForContext(step));
      }
    }
  }

  // respondOnly 模式：不追加 JSON 输出指令，让 LLM 自由输出 Markdown
  if (!respondOnly) {
    parts.push(
      `\n\n## 当前步骤: 第 ${currentStep} 步`,
      "调用 agent_decide 函数来报告你的 observation、analysis、plan、decision。不要输出原始 JSON 文本。",
    );
  }

  return parts.join("\n");
}

/**
 * Format a single step for injection into the LLM iteration context.
 */
export function formatStepForContext(step: AgentStep): string {
  const lines = [
    `\n第 ${step.step} 步:`,
    `- 观察: ${step.observation}`,
    `- 决策: ${step.decision.action}`,
  ];
  if (step.result) {
    lines.push(`- 结果: ${step.result}`);
  }
  if (step.error) {
    lines.push(`- 错误: ${step.error.message}`);
  }
  return lines.join("\n");
}
