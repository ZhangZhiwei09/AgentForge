// MemoryCompressor tests — scoreImportance, compress, compressWithLLM
import { describe, it, expect, vi } from "vitest";
import {
  MemoryCompressor,
  SCRATCHPAD_COMPRESSION_THRESHOLD,
  HIGH_IMPORTANCE_THRESHOLD,
} from "../memory-compressor.js";
import type { AgentStep, AgentDecision } from "@agentforge/shared-types";

function makeStep(
  step: number,
  action: AgentDecision["action"],
  overrides: Partial<{
    tool: string;
    result: string;
    observation: string;
    analysis: string;
    plan: string;
    error: AgentStep["error"];
  }> = {},
): AgentStep {
  const baseDecision: AgentDecision =
    action === "respond"
      ? { action: "respond", content: "Answer", summary: "Done" }
      : action === "ask_user"
        ? { action: "ask_user", question: "Q?", context: "Context" }
        : {
            action: "tool_call",
            tool: overrides.tool || "calculator",
            args: {},
            reason: "Need this",
          };

  return {
    step,
    observation: overrides.observation || `Step ${step} observation`,
    analysis: overrides.analysis || `Step ${step} analysis`,
    plan: overrides.plan || `Step ${step} plan`,
    decision: baseDecision,
    result: overrides.result,
    timestamp: new Date().toISOString(),
    error: overrides.error,
  };
}

describe("MemoryCompressor", () => {
  const compressor = new MemoryCompressor();

  // ---- scoreImportance ----
  describe("scoreImportance", () => {
    it("respond steps get +5 bonus", () => {
      const steps = [makeStep(1, "respond")];
      const scored = compressor.scoreImportance(steps);
      // base 5 + respond 5 + first step 2 = 12
      expect(scored[0].score).toBeGreaterThanOrEqual(10);
      expect(scored[0].reason).toContain("最终回复");
    });

    it("critical tool calls get +3 bonus", () => {
      const criticalTools = [
        "file_read",
        "db_query",
        "web_search",
        "web_fetch",
        "http_request",
        "code_execute",
        "file_search",
      ];
      for (const tool of criticalTools) {
        const steps = [makeStep(1, "tool_call", { tool })];
        const scored = compressor.scoreImportance(steps);
        // base 5 + critical 3 + first 2 = 10
        expect(scored[0].score).toBeGreaterThanOrEqual(
          HIGH_IMPORTANCE_THRESHOLD,
        );
        expect(scored[0].reason).toContain("关键工具");
      }
    });

    it("trivial tool calls get -2 penalty", () => {
      const trivialTools = ["calculator", "get_current_time"];
      for (const tool of trivialTools) {
        const steps = [makeStep(1, "tool_call", { tool })];
        const scored = compressor.scoreImportance(steps);
        // base 5 + first 2 - trivial 2 = 5
        expect(scored[0].score).toBeLessThan(HIGH_IMPORTANCE_THRESHOLD);
      }
    });

    it("ask_user steps get +2 bonus", () => {
      const steps = [makeStep(1, "ask_user")];
      const scored = compressor.scoreImportance(steps);
      // base 5 + ask_user 2 + first 2 = 9
      expect(scored[0].score).toBeGreaterThanOrEqual(7);
      expect(scored[0].reason).toContain("用户澄清");
    });

    it("plan change detection adds +3", () => {
      const steps = [
        makeStep(1, "tool_call", {
          tool: "web_search",
          analysis: "需要改变计划",
          plan: "换个思路试试",
        }),
      ];
      const scored = compressor.scoreImportance(steps);
      // base 5 + critical 3 + plan_change 3 + first 2 = 13
      expect(scored[0].score).toBeGreaterThanOrEqual(HIGH_IMPORTANCE_THRESHOLD);
      expect(scored[0].reason).toContain("策略调整");
    });

    it("error steps get +1 bonus", () => {
      // Use a step that is not first and not in early recovery range
      const steps = [
        makeStep(1, "tool_call"),
        makeStep(2, "tool_call"),
        makeStep(3, "tool_call"),
        makeStep(4, "tool_call", {
          error: { category: "retryable", message: "timeout", retried: true },
        }),
      ];
      const scored = compressor.scoreImportance(steps);
      // index 3: base 5 - trivial 2 + error 1 = 4, below threshold
      const errorStep = scored[3];
      expect(errorStep.score).toBeLessThan(HIGH_IMPORTANCE_THRESHOLD);
      expect(errorStep.reason).toContain("包含错误");
    });

    it("first step gets +2 bonus", () => {
      const steps = [
        makeStep(1, "tool_call"),
        makeStep(2, "tool_call"),
        makeStep(3, "tool_call"),
      ];
      const scored = compressor.scoreImportance(steps);
      // First step: base 5 + first 2 - trivial 2 = 5
      // Later steps: base 5 - trivial 2 = 3
      expect(scored[0].score).toBeGreaterThan(scored[1].score);
    });

    it("early error recovery steps get +2 bonus", () => {
      const steps = [
        makeStep(1, "tool_call", {
          error: { category: "degradable", message: "failed", retried: false },
        }),
        makeStep(2, "tool_call", {
          tool: "web_search",
          analysis: "需要修复前面的错误",
          plan: "用替代方案重试",
        }),
      ];
      const scored = compressor.scoreImportance(steps);
      // Step 0: base 5 + first 2 - trivial 2 + error 1 = 6
      // Step 1: base 5 + critical 3 + early recovery 2 = 10
      expect(scored[0].score).toBeGreaterThanOrEqual(4);
      expect(scored[1].score).toBeGreaterThanOrEqual(HIGH_IMPORTANCE_THRESHOLD);
    });
  });

  // ---- compress ----
  describe("compress", () => {
    it("returns no compression when below threshold", () => {
      const steps = [
        makeStep(1, "tool_call", { tool: "web_search", result: "Found info" }),
        makeStep(2, "tool_call", { tool: "file_read", result: "File content" }),
        makeStep(3, "respond"),
      ];
      const result = compressor.compress(steps);
      expect(result.compressedCount).toBe(0);
      expect(result.summary).toBe("");
      expect(result.keptSteps).toHaveLength(steps.length);
    });

    it("compresses when above threshold (6+ steps)", () => {
      const steps = [
        makeStep(1, "tool_call", { tool: "web_search", result: "R1" }),
        makeStep(2, "tool_call", { tool: "calculator", result: "42" }),
        makeStep(3, "tool_call", { tool: "calculator", result: "7" }),
        makeStep(4, "tool_call", { tool: "get_current_time", result: "Now" }),
        makeStep(5, "tool_call", { tool: "calculator", result: "100" }),
        makeStep(6, "respond"),
      ];
      expect(steps.length).toBeGreaterThan(SCRATCHPAD_COMPRESSION_THRESHOLD);

      const result = compressor.compress(steps);
      expect(result.compressedCount).toBeGreaterThan(0);
      expect(result.summary).toBeTruthy();
      expect(result.summary).toContain("压缩摘要");
      // The respond step (6) and first search step should be kept
      const keptStepNums = result.keptSteps.map((s) => s.step);
      expect(keptStepNums).toContain(6); // respond always kept
      expect(keptStepNums).toContain(1); // first step + critical tool
    });

    it("keeps high-importance steps (score >= threshold)", () => {
      const steps = [
        makeStep(1, "tool_call", { tool: "web_search", result: "Critical data" }),
        makeStep(2, "tool_call", { tool: "calculator", result: "42" }),
        makeStep(3, "tool_call", { tool: "calculator", result: "84" }),
        makeStep(4, "tool_call", { tool: "get_current_time", result: "12:00" }),
        makeStep(5, "tool_call", { tool: "calculator", result: "168" }),
        makeStep(6, "respond"),
      ];

      const result = compressor.compress(steps);
      const kept = result.keptSteps;
      // All kept steps should have importance >= threshold
      const scored = compressor.scoreImportance(steps);
      for (const s of kept) {
        const sc = scored.find((x) => x.step.step === s.step);
        expect(sc).toBeDefined();
        expect(sc!.score).toBeGreaterThanOrEqual(HIGH_IMPORTANCE_THRESHOLD);
      }
    });

    it("generates Chinese summary for compressed steps", () => {
      const steps = [
        makeStep(1, "tool_call", { tool: "web_search", result: "Found" }),
        makeStep(2, "tool_call", { tool: "calculator", result: "42" }),
        makeStep(3, "tool_call", { tool: "calculator", result: "84" }),
        makeStep(4, "tool_call", { tool: "get_current_time", result: "12:00" }),
        makeStep(5, "tool_call", { tool: "calculator", result: "168" }),
        makeStep(6, "respond"),
      ];

      const result = compressor.compress(steps);
      // Should contain Chinese text (compression summary)
      expect(result.summary).toMatch(/[一-鿿]/);
      expect(result.compressedCount).toBeGreaterThan(0);
    });

    it("no compression when all steps are high importance", () => {
      // Create all high-importance steps (critical tools + plan changes)
      const steps = [
        makeStep(1, "tool_call", {
          tool: "file_read",
          result: "R1",
          analysis: "需要改变计划",
          plan: "调整策略",
        }),
        makeStep(2, "tool_call", {
          tool: "db_query",
          result: "R2",
          analysis: "换个思路",
          plan: "重新规划路径",
        }),
        makeStep(3, "tool_call", {
          tool: "web_search",
          result: "R3",
          analysis: "修正计划",
          plan: "替代方案",
        }),
        makeStep(4, "tool_call", {
          tool: "code_execute",
          result: "R4",
          analysis: "重新评估",
          plan: "策略调整",
        }),
        makeStep(5, "tool_call", {
          tool: "http_request",
          result: "R5",
          analysis: "换一种方式",
          plan: "新方案",
        }),
        makeStep(6, "respond"),
      ];

      const result = compressor.compress(steps);
      // All should be high importance → no compression needed
      expect(result.compressedCount).toBe(0);
      expect(result.keptSteps).toHaveLength(steps.length);
    });

    it("forces keeping last 2 steps when compression removes too many", () => {
      // All trivial steps + a final respond
      const steps = [
        makeStep(1, "tool_call", { tool: "calculator", result: "1" }),
        makeStep(2, "tool_call", { tool: "get_current_time", result: "t1" }),
        makeStep(3, "tool_call", { tool: "calculator", result: "3" }),
        makeStep(4, "tool_call", { tool: "get_current_time", result: "t2" }),
        makeStep(5, "tool_call", { tool: "calculator", result: "5" }),
        makeStep(6, "respond"),
      ];

      const result = compressor.compress(steps);
      // Should have at least 2 kept steps (respond + forced last 2)
      expect(result.keptSteps.length).toBeGreaterThanOrEqual(2);
    });

    it("handles empty scratchpad", () => {
      const result = compressor.compress([]);
      expect(result.compressedCount).toBe(0);
      expect(result.keptSteps).toHaveLength(0);
      expect(result.summary).toBe("");
    });
  });

  // ---- compressWithLLM ----
  describe("compressWithLLM", () => {
    it("returns base result when compression is not needed", async () => {
      const steps = [makeStep(1, "respond")];
      const mockProvider = {
        chatSync: vi.fn(),
        streamChat: vi.fn(),
        listModels: vi.fn(),
      };

      const result = await compressor.compressWithLLM(
        steps,
        mockProvider as any,
        "gpt-4o",
      );
      expect(result.compressedCount).toBe(0);
      expect(mockProvider.chatSync).not.toHaveBeenCalled();
    });

    it("uses LLM chatSync for summary generation", async () => {
      const steps = [
        makeStep(1, "tool_call", { tool: "web_search", result: "R1" }),
        makeStep(2, "tool_call", { tool: "calculator", result: "42" }),
        makeStep(3, "tool_call", { tool: "calculator", result: "84" }),
        makeStep(4, "tool_call", { tool: "calculator", result: "168" }),
        makeStep(5, "tool_call", { tool: "get_current_time", result: "T" }),
        makeStep(6, "respond"),
      ];

      const mockProvider = {
        chatSync: vi.fn(async () => ({
          content: "这是一个LLM生成的压缩摘要。",
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        })),
        streamChat: vi.fn(),
        listModels: vi.fn(),
      };

      const result = await compressor.compressWithLLM(
        steps,
        mockProvider as any,
        "deepseek-v4-flash",
      );

      expect(mockProvider.chatSync).toHaveBeenCalled();
      // Should use LLM summary instead of rule-based
      expect(result.summary).toBe("这是一个LLM生成的压缩摘要。");
      expect(result.compressedCount).toBeGreaterThan(0);
    });

    it("falls back to rule-based summary on LLM error", async () => {
      const steps = [
        makeStep(1, "tool_call", { tool: "web_search", result: "R1" }),
        makeStep(2, "tool_call", { tool: "calculator", result: "42" }),
        makeStep(3, "tool_call", { tool: "calculator", result: "84" }),
        makeStep(4, "tool_call", { tool: "calculator", result: "168" }),
        makeStep(5, "tool_call", { tool: "get_current_time", result: "T" }),
        makeStep(6, "respond"),
      ];

      const mockProvider = {
        chatSync: vi.fn(async () => {
          throw new Error("LLM timeout");
        }),
        streamChat: vi.fn(),
        listModels: vi.fn(),
      };

      const result = await compressor.compressWithLLM(
        steps,
        mockProvider as any,
        "gpt-4o",
      );

      // Should fall back to rule-based summary
      expect(result.summary).toContain("压缩摘要");
      expect(result.compressedCount).toBeGreaterThan(0);
    });

    it("passes temperature=0 and maxTokens=800 to LLM", async () => {
      const steps = [
        makeStep(1, "tool_call", { tool: "web_search", result: "R1" }),
        makeStep(2, "tool_call", { tool: "calculator", result: "42" }),
        makeStep(3, "tool_call", { tool: "calculator", result: "84" }),
        makeStep(4, "tool_call", { tool: "calculator", result: "168" }),
        makeStep(5, "tool_call", { tool: "get_current_time", result: "T" }),
        makeStep(6, "respond"),
      ];

      const chatSync = vi.fn(
        async (
          _msgs: unknown[],
          _model: string,
          _sysPrompt?: string,
          temperature?: number,
          maxTokens?: number,
        ) => ({
          content: "摘要",
          usage: { prompt_tokens: 50, completion_tokens: 20 },
        }),
      );
      const mockProvider = {
        chatSync,
        streamChat: vi.fn(),
        listModels: vi.fn(),
      };

      await compressor.compressWithLLM(
        steps,
        mockProvider as any,
        "deepseek-v4-flash",
      );

      // Verify LLM was called (compression is triggered)
      expect(chatSync).toHaveBeenCalled();
      const callArgs = chatSync.mock.calls[0];
      expect(callArgs[1]).toBe("deepseek-v4-flash"); // model
      expect(callArgs[3]).toBe(0); // temperature
      expect(callArgs[4]).toBe(800); // maxTokens
    });
  });
});
