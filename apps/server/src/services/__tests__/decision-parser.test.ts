// decision-parser tests — parseAgentDecideFromArgs and parseStep field mapping
import { describe, it, expect } from "vitest";
import { parseAgentDecideFromArgs, parseStep } from "../agent/decision-parser.js";

describe("parseAgentDecideFromArgs", () => {
  it("should map clarify_context → context for ask_user", () => {
    const args = JSON.stringify({
      observation: "obs",
      analysis: "an",
      plan: "pl",
      action: "ask_user",
      question: "Which file?",
      clarify_context: "Multiple files found",
    });

    const step = parseAgentDecideFromArgs(args, 1);
    expect(step).not.toBeNull();
    expect(step!.decision.action).toBe("ask_user");
    if (step!.decision.action === "ask_user") {
      expect(step!.decision.question).toBe("Which file?");
      expect(step!.decision.context).toBe("Multiple files found");
    }
  });

  it("should handle ask_user with empty clarify_context", () => {
    const args = JSON.stringify({
      observation: "obs",
      analysis: "an",
      plan: "pl",
      action: "ask_user",
      question: "What do you need?",
    });

    const step = parseAgentDecideFromArgs(args, 1);
    expect(step).not.toBeNull();
    if (step!.decision.action === "ask_user") {
      expect(step!.decision.question).toBe("What do you need?");
      expect(step!.decision.context).toBe("");
    }
  });
});

describe("parseStep", () => {
  it("should map clarify_context → context for ask_user (text-parse path)", () => {
    const response = JSON.stringify({
      observation: "Ambiguous request",
      analysis: "Need clarification",
      plan: "Ask user",
      decision: {
        action: "ask_user",
        question: "Which file do you want?",
        clarify_context: "Found 3 files",
      },
    });

    const step = parseStep(response, 1);
    expect(step).not.toBeNull();
    expect(step!.decision.action).toBe("ask_user");
    if (step!.decision.action === "ask_user") {
      expect(step!.decision.question).toBe("Which file do you want?");
      // P0 fix: clarify_context must be mapped to context
      expect(step!.decision.context).toBe("Found 3 files");
    }
  });

  it("should use context field when clarify_context is absent (text-parse path)", () => {
    const response = JSON.stringify({
      observation: "obs",
      analysis: "an",
      plan: "pl",
      decision: {
        action: "ask_user",
        question: "Please clarify",
        context: "User context info",
      },
    });

    const step = parseStep(response, 1);
    expect(step).not.toBeNull();
    if (step!.decision.action === "ask_user") {
      expect(step!.decision.context).toBe("User context info");
    }
  });

  it("should prefer clarify_context over context when both present", () => {
    const response = JSON.stringify({
      observation: "obs",
      analysis: "an",
      plan: "pl",
      decision: {
        action: "ask_user",
        question: "Which one?",
        clarify_context: "From tool schema",
        context: "From raw field",
      },
    });

    const step = parseStep(response, 1);
    expect(step).not.toBeNull();
    if (step!.decision.action === "ask_user") {
      // clarify_context takes precedence (matches parseAgentDecideFromArgs behavior)
      expect(step!.decision.context).toBe("From tool schema");
    }
  });

  it("should handle respond decision with proper field mapping", () => {
    const response = JSON.stringify({
      observation: "obs",
      analysis: "an",
      plan: "pl",
      decision: {
        action: "respond",
        content: "Here is the answer",
        summary: "Answered",
      },
    });

    const step = parseStep(response, 1);
    expect(step).not.toBeNull();
    if (step!.decision.action === "respond") {
      expect(step!.decision.content).toBe("Here is the answer");
      expect(step!.decision.summary).toBe("Answered");
    }
  });

  it("should handle tool_call decision with args_json parsing", () => {
    const response = JSON.stringify({
      observation: "obs",
      analysis: "an",
      plan: "pl",
      decision: {
        action: "tool_call",
        tool: "calculator",
        args_json: '{"expr":"2+2"}',
        reason: "Need math",
      },
    });

    const step = parseStep(response, 1);
    expect(step).not.toBeNull();
    if (step!.decision.action === "tool_call") {
      expect(step!.decision.tool).toBe("calculator");
      expect(step!.decision.args).toEqual({ expr: "2+2" });
      expect(step!.decision.reason).toBe("Need math");
    }
  });

  it("should map non-standard action (tool name) to tool_call", () => {
    const response = JSON.stringify({
      observation: "obs",
      analysis: "an",
      plan: "pl",
      decision: {
        action: "search_knowledge_base",
        args_json: '{"query":"test"}',
        reason: "Search needed",
      },
    });

    const step = parseStep(response, 1);
    expect(step).not.toBeNull();
    if (step!.decision.action === "tool_call") {
      expect(step!.decision.tool).toBe("search_knowledge_base");
    }
  });

  it("should return null for invalid JSON", () => {
    const step = parseStep("not json at all", 1);
    expect(step).toBeNull();
  });

  it("should return null when required fields are missing", () => {
    const response = JSON.stringify({
      observation: "obs",
      // missing analysis, plan, decision
    });

    const step = parseStep(response, 1);
    expect(step).toBeNull();
  });
});
