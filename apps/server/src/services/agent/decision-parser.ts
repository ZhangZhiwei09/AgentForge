// Decision parsing for AgentService — JSON and function-call dual-path parsing
import { parseJSONFromLLMResponse } from "../../lib/json-utils.js";
import { logger } from "@agentforge/logger";
import type { AgentStep, AgentDecision } from "@agentforge/shared-types";

/**
 * Parse agent_decide tool call arguments into a structured AgentStep.
 * Used by all ReAct loop methods to avoid duplicating the JSON parsing logic.
 */
export function parseAgentDecideFromArgs(
  rawArgs: string,
  totalSteps: number,
): AgentStep | null {
  try {
    const a = JSON.parse(rawArgs);
    const action: string = a.action || "respond";

    let decision: AgentDecision;
    switch (action) {
      case "tool_call":
        decision = {
          action: "tool_call",
          tool: String(a.tool || ""),
          args: (() => {
            try {
              return JSON.parse(a.args_json || "{}");
            } catch (err: unknown) {
              logger.warn(
                { argsJson: a.args_json?.slice(0, 200) },
                "Failed to parse agent decision args_json, using empty args",
              );
              return {};
            }
          })(),
          reason: String(a.reason || ""),
        };
        break;
      case "ask_user":
        decision = {
          action: "ask_user",
          question: String(a.question || ""),
          context: String(a.clarify_context || ""),
        };
        break;
      default: // respond
        decision = {
          action: "respond",
          content: String(a.content || ""),
          summary: String(a.summary || ""),
        };
    }

    return {
      step: totalSteps,
      observation: String(a.observation || ""),
      analysis: String(a.analysis || ""),
      plan: String(a.plan || ""),
      decision,
      timestamp: new Date().toISOString(),
    };
  } catch {
    logger.warn(
      { args: rawArgs },
      "Failed to parse agent_decide tool arguments",
    );
    return null;
  }
}

/**
 * Parse the LLM's JSON response into a structured AgentStep.
 * This is the fallback path when the LLM outputs JSON text instead of
 * using the agent_decide tool call.
 */
export function parseStep(
  response: string,
  stepNumber: number,
): AgentStep | null {
  try {
    const parsed = parseJSONFromLLMResponse(response);
    if (!parsed || typeof parsed !== "object") {
      logger.warn(
        { response: response.slice(0, 200) },
        "No JSON object found in agent response",
      );
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    if (!obj.observation || !obj.analysis || !obj.plan || !obj.decision) {
      logger.warn({ obj }, "Missing required fields in agent decision");
      return null;
    }

    const decision = obj.decision as Record<string, unknown>;

    // ── 规范化 action：LLM 可能输出工具名称（如 search_knowledge_base）而非 tool_call ──
    let action: string = String(decision.action || "respond");

    // Validate decision type
    if (!["tool_call", "respond", "ask_user"].includes(action)) {
      // 如果 action 不是标准值，检查是否为已知工具名
      // LLM 可能直接输出工具名作为 action（如 search_knowledge_base）
      const toolName = String(decision.action || "").trim();
      if (toolName && toolName !== "respond" && toolName !== "ask_user") {
        // Map to tool_call: 将工具名映射为标准格式
        const argsJson =
          typeof decision.args_json === "string" ? decision.args_json : "{}";
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(argsJson);
        } catch {
          args = { query: String(decision.query || "") };
        }
        const updatedDecision: AgentDecision = {
          action: "tool_call",
          tool: toolName,
          args,
          reason: String(decision.reason || ""),
        };
        return {
          step: stepNumber,
          observation: String(obj.observation),
          analysis: String(obj.analysis),
          plan: String(obj.plan),
          decision: updatedDecision,
          timestamp: new Date().toISOString(),
        };
      }

      logger.warn({ action: decision.action }, "Invalid decision action");
      return null;
    }

    // 构造 AgentDecision — 与 parseAgentDecideFromArgs 保持一致的字段映射
    let validDecision: AgentDecision;
    if (action === "tool_call") {
      validDecision = {
        action: "tool_call",
        tool: String(decision.tool || ""),
        args: typeof decision.args === "object" && decision.args !== null
          ? (decision.args as Record<string, unknown>)
          : (() => {
              // 尝试从 args_json 解析
              try {
                return JSON.parse(String(decision.args_json || "{}"));
              } catch {
                return {};
              }
            })(),
        reason: String(decision.reason || ""),
      };
    } else if (action === "ask_user") {
      validDecision = {
        action: "ask_user",
        // LLM 可能使用 clarify_context（tool schema 参数名）或 context
        question: String(decision.question || ""),
        context: String(decision.clarify_context || decision.context || ""),
      };
    } else {
      // respond
      validDecision = {
        action: "respond",
        content: String(decision.content || ""),
        summary: String(decision.summary || ""),
      };
    }

    return {
      step: stepNumber,
      observation: String(obj.observation),
      analysis: String(obj.analysis),
      plan: String(obj.plan),
      decision: validDecision,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : "Unknown error", response: response.slice(0, 300) },
      "Failed to parse agent decision JSON",
    );
    return null;
  }
}
