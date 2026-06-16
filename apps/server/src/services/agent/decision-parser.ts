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

    const decision = obj.decision as AgentDecision;

    // Validate decision type
    if (!["tool_call", "respond", "ask_user"].includes(decision.action)) {
      logger.warn({ action: decision.action }, "Invalid decision action");
      return null;
    }

    return {
      step: stepNumber,
      observation: String(obj.observation),
      analysis: String(obj.analysis),
      plan: String(obj.plan),
      decision,
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
