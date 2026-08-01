import { describe, it, expect } from "vitest";
import type {
  RiskLevel,
  RegisteredTool,
  CircuitBreakerState,
} from "../types.js";
import { RISK_TIMEOUTS } from "../types.js";
import type { ToolDefinition } from "@agentforge/shared-types";
import { successResult } from "../../runtime/results.js";

describe("RiskLevel hierarchy", () => {
  const order: RiskLevel[] = ["safe", "read_only", "mutation", "destructive"];

  it("should have strictly increasing RISK_TIMEOUTS", () => {
    for (let i = 1; i < order.length; i++) {
      const prev = RISK_TIMEOUTS[order[i - 1]];
      const curr = RISK_TIMEOUTS[order[i]];
      expect(
        curr,
        `${order[i]} timeout (${curr}) must be > ${order[i - 1]} timeout (${prev})`,
      ).toBeGreaterThan(prev);
    }
  });

  it("should have positive RISK_TIMEOUTS for all levels", () => {
    for (const level of order) {
      expect(
        RISK_TIMEOUTS[level],
        `${level} timeout must be positive`,
      ).toBeGreaterThan(0);
    }
  });

  it("should define all 4 risk level keys in RISK_TIMEOUTS", () => {
    expect(Object.keys(RISK_TIMEOUTS).sort()).toEqual([...order].sort());
  });
});

describe("RegisteredTool interface", () => {
  it("should construct a valid RegisteredTool object", () => {
    const mockDefinition: ToolDefinition = {
      type: "function",
      function: {
        name: "test_tool",
        description: "A test tool for unit testing",
        parameters: {
          type: "object",
          properties: {
            input: { type: "string", description: "test input" },
          },
          required: ["input"],
        },
      },
    };

    const tool: RegisteredTool = {
      definition: mockDefinition,
      execute: async () => successResult("ok"),
      riskLevel: "read_only",
      timeout: 10_000,
      requireApproval: false,
      category: "utility",
      parallelizable: true,
    };

    expect(tool.definition.function.name).toBe("test_tool");
    expect(tool.riskLevel).toBe("read_only");
    expect(tool.timeout).toBe(10_000);
    expect(tool.requireApproval).toBe(false);
    expect(tool.category).toBe("utility");
    expect(tool.parallelizable).toBe(true);
    expect(tool.sandbox).toBeUndefined();
  });

  it("should construct with optional sandbox field", () => {
    const tool: RegisteredTool = {
      definition: {
        type: "function",
        function: {
          name: "sandbox_tool",
          description: "A sandboxed tool",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => successResult("sandboxed"),
      riskLevel: "destructive",
      timeout: 60_000,
      requireApproval: true,
      category: "sandbox",
      parallelizable: false,
      sandbox: true,
    };

    expect(tool.sandbox).toBe(true);
    expect(tool.riskLevel).toBe("destructive");
  });
});

describe("CircuitBreakerState interface", () => {
  it("should construct a closed state (failures=0, open=false)", () => {
    const state: CircuitBreakerState = {
      failures: 0,
      lastFailure: 0,
      open: false,
      openedAt: 0,
    };

    expect(state.failures).toBe(0);
    expect(state.open).toBe(false);
  });

  it("should construct an open state (open=true, openedAt set)", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failures: 5,
      lastFailure: now,
      open: true,
      openedAt: now,
    };

    expect(state.open).toBe(true);
    expect(state.openedAt).toBe(now);
    expect(state.failures).toBeGreaterThan(0);
  });
});
