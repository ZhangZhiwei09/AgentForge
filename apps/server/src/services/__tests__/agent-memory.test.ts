// Agent memory compression integration tests — P0-3
// Verifies that AgentService's buildIterationContext incorporates compression correctly
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Hoisted mock refs ----
const {
  mockAgentStreamChat,
  mockToolExecute,
  mockToolListNames,
  mockToolGetDefinitions,
  mockTruncateHistory,
} = vi.hoisted(() => ({
  mockAgentStreamChat: vi.fn(),
  mockToolExecute: vi.fn(async () => "tool result"),
  mockToolListNames: vi.fn(() => ["calculator", "web_search"]),
  mockToolGetDefinitions: vi.fn(() => []),
  mockTruncateHistory: vi.fn((msgs: Array<unknown>) => msgs),
}));

// ---- Mocks ----
vi.mock("../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({
    streamChat: mockAgentStreamChat,
    chatSync: vi.fn(),
    listModels: vi.fn(() => [
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", max_tokens: 128000 },
    ]),
  })),
  resolveModel: vi.fn(() => ["openai", "gpt-4o"]),
  listProviders: vi.fn(() => []),
}));

vi.mock("../../tools/registry.js", () => ({
  toolRegistry: {
    init: vi.fn(),
    getDefinitions: mockToolGetDefinitions,
    execute: mockToolExecute,
    listNames: mockToolListNames,
    getAll: vi.fn(() => []),
  },
}));

vi.mock("../../lib/context-window.js", () => ({
  truncateHistory: mockTruncateHistory,
  estimateTokenCount: vi.fn(() => 100),
}));

vi.mock("../../lib/json-utils.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/json-utils.js")
  >("../../lib/json-utils.js");
  return actual;
});

vi.mock("@agentforge/shared-prompts", () => ({
  react_system_prompt: {
    content: "You are a helpful agent. Use agent_decide for decisions.",
  },
}));

const conversationStore = new Map<string, Record<string, unknown>>();
const messageStore = new Map<string, Array<Record<string, unknown>>>();
const sessionStore = new Map<string, Record<string, unknown>>();

vi.mock("../../db.js", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return conversationStore.get(args.where.id) || null;
      }),
      findFirst: vi.fn(async () => null),
    },
    message: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const msgs = messageStore.get(args.data.conversationId as string) || [];
        msgs.push(args.data);
        messageStore.set(args.data.conversationId as string, msgs);
        return args.data;
      }),
      findMany: vi.fn(async () => []),
    },
    agentSession: {
      upsert: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return sessionStore.get(args.where.id) || null;
      }),
    },
    agentApproval: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

import { AgentService } from "../agent.js";
import {
  MemoryCompressor,
  SCRATCHPAD_COMPRESSION_THRESHOLD,
} from "../memory-compressor.js";
import type { AgentStep } from "@agentforge/shared-types";

describe("Agent Memory Compression", () => {
  let service: AgentService;
  let compressor: MemoryCompressor;

  beforeEach(() => {
    service = new AgentService();
    compressor = new MemoryCompressor();
    conversationStore.clear();
    messageStore.clear();
    sessionStore.clear();
    vi.clearAllMocks();

    conversationStore.set("conv-mem", {
      id: "conv-mem",
      userId: "user-mem",
      title: "Memory Test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  async function collectAgentEvents(
    gen: AsyncGenerator<unknown>,
  ): Promise<Array<Record<string, unknown>>> {
    const events: Array<Record<string, unknown>> = [];
    for await (const event of gen) {
      events.push(event as Record<string, unknown>);
    }
    return events;
  }

  describe("MemoryCompressor (unit)", () => {
    it("does not compress when scratchpad is below threshold", () => {
      const steps: AgentStep[] = [
        {
          step: 1,
          observation: "Task received",
          analysis: "Simple task",
          plan: "Execute directly",
          decision: {
            action: "tool_call",
            tool: "calculator",
            args: {},
            reason: "need calc",
          },
          result: "42",
          timestamp: new Date().toISOString(),
        },
        {
          step: 2,
          observation: "Result obtained",
          analysis: "Task complete",
          plan: "Respond to user",
          decision: {
            action: "respond",
            content: "Answer is 42",
            summary: "Done",
          },
          timestamp: new Date().toISOString(),
        },
      ];

      expect(steps.length).toBeLessThan(SCRATCHPAD_COMPRESSION_THRESHOLD);
      const result = compressor.compress(steps);
      expect(result.compressedCount).toBe(0);
    });

    it("compresses when scratchpad exceeds threshold", () => {
      const steps: AgentStep[] = Array.from({ length: 7 }, (_, i) => ({
        step: i + 1,
        observation: `Step ${i + 1}`,
        analysis: `Analysis ${i + 1}`,
        plan: `Plan ${i + 1}`,
        decision:
          i === 6
            ? ({
                action: "respond",
                content: "Done",
                summary: "All done",
              } as const)
            : i === 0
              ? ({
                  action: "tool_call",
                  tool: "web_search",
                  args: {},
                  reason: "Search",
                } as const)
              : ({
                  action: "tool_call",
                  tool: "calculator",
                  args: {},
                  reason: `Calc ${i}`,
                } as const),
        result: `Result ${i + 1}`,
        timestamp: new Date().toISOString(),
      }));

      expect(steps.length).toBeGreaterThan(SCRATCHPAD_COMPRESSION_THRESHOLD);

      const result = compressor.compress(steps);
      expect(result.compressedCount).toBeGreaterThan(0);
      // Respond step (index 6) should always be kept
      const keptNums = result.keptSteps.map((s) => s.step);
      expect(keptNums).toContain(7); // respond
      expect(keptNums).toContain(1); // first step + critical tool
      // Summary should contain Chinese text
      expect(result.summary).toMatch(/[一-鿿]/);
    });

    it("importance scoring retains critical data-fetching steps", () => {
      const criticalStep: AgentStep = {
        step: 1,
        observation: "Need data",
        analysis: "Requires DB query",
        plan: "Query database",
        decision: {
          action: "tool_call",
          tool: "db_query",
          args: {},
          reason: "Get data",
        },
        result: "Data found",
        timestamp: new Date().toISOString(),
      };

      const trivialStep: AgentStep = {
        step: 2,
        observation: "Need math",
        analysis: "Simple calculation",
        plan: "Use calculator",
        decision: {
          action: "tool_call",
          tool: "calculator",
          args: {},
          reason: "Add numbers",
        },
        result: "100",
        timestamp: new Date().toISOString(),
      };

      const scored = compressor.scoreImportance([criticalStep, trivialStep]);
      expect(scored[0].score).toBeGreaterThan(scored[1].score);
    });
  });

  describe("AgentService buildIterationContext with compression", () => {
    it("builds context with compressed summary when provided", () => {
      // Access private method via prototype for testing
      const context = (service as any).buildIterationContext(
        "System prompt",
        "Do the task",
        [], // empty scratchpad
        1,
        "Test compressed summary",
        new Set([1, 3]),
      );

      expect(context).toContain("System prompt");
      expect(context).toContain("Do the task");
    });

    it("handles undefined compression params gracefully", () => {
      const context = (service as any).buildIterationContext(
        "System prompt",
        "Do the task",
        [],
        1,
        undefined,
        undefined,
      );

      expect(context).toContain("System prompt");
      expect(context).toContain("Do the task");
    });

    it("shows full scratchpad when no compression", () => {
      const steps: AgentStep[] = [
        {
          step: 1,
          observation: "Obs",
          analysis: "Ana",
          plan: "Plan",
          decision: {
            action: "tool_call",
            tool: "web_search",
            args: {},
            reason: "search",
          },
          result: "Found",
          timestamp: new Date().toISOString(),
        },
      ];

      const context = (service as any).buildIterationContext(
        "Sys",
        "Task",
        steps,
        2,
      );

      expect(context).toContain("历史步骤");
      expect(context).toContain("第 1 步");
      expect(context).toContain("Obs");
    });

    it("shows compressed summary and kept steps when compression active", () => {
      const steps: AgentStep[] = [
        {
          step: 1,
          observation: "Critical observation",
          analysis: "Critical analysis",
          plan: "Critical plan",
          decision: {
            action: "tool_call",
            tool: "web_search",
            args: {},
            reason: "search",
          },
          result: "Found",
          timestamp: new Date().toISOString(),
        },
        {
          step: 2,
          observation: "Trivial step",
          analysis: "Nothing important",
          plan: "Just calculate",
          decision: {
            action: "tool_call",
            tool: "calculator",
            args: {},
            reason: "calc",
          },
          result: "42",
          timestamp: new Date().toISOString(),
        },
      ];

      const keptStepNumbers = new Set([1]); // only keep step 1

      const context = (service as any).buildIterationContext(
        "Sys",
        "Task",
        steps,
        3,
        "[压缩摘要] 已压缩1个步骤",
        keptStepNumbers,
      );

      expect(context).toContain("压缩摘要");
      expect(context).toContain("保留的关键步骤");
      expect(context).toContain("Critical observation");
      // Step 2 should not appear (not in kept set)
      expect(context).not.toContain("Trivial step");
    });

    it("formats steps with error information", () => {
      const steps: AgentStep[] = [
        {
          step: 1,
          observation: "Error step",
          analysis: "Something went wrong",
          plan: "Retry",
          decision: {
            action: "tool_call",
            tool: "http_request",
            args: {},
            reason: "fetch",
          },
          result: "Failed",
          error: {
            category: "retryable",
            message: "Network timeout",
            retried: true,
            attempts: 2,
          },
          timestamp: new Date().toISOString(),
        },
      ];

      const context = (service as any).buildIterationContext(
        "Sys",
        "Task",
        steps,
        2,
      );

      expect(context).toContain("Network timeout");
    });
  });

  describe("AgentService multi-step task triggers compression", () => {
    it("agent runs 6+ tool call steps and compression should be exercisable", async () => {
      // This test verifies the compression flow is wired in:
      // the agent handles a multi-step task and compression state is
      // tracked. We don't assert on internal compression state since
      // it's not externally visible, but we verify the agent completes
      // without errors.
      let callCount = 0;
      mockAgentStreamChat.mockImplementation(async function* () {
        callCount++;
        if (callCount <= 5) {
          // Tool calls for steps 1-5
          yield {
            type: "tool_call",
            tool_call: {
              id: `tc-${callCount}`,
              name: "agent_decide",
              arguments: JSON.stringify({
                observation: `Step ${callCount}`,
                analysis: "Need more work",
                plan: "Continue",
                action: "tool_call",
                tool: "calculator",
                args_json: '{"expr":"1+1"}',
                reason: "Need calculation",
              }),
            },
          };
          yield {
            type: "done",
            usage: { prompt_tokens: 10, completion_tokens: 8 },
          };
        } else {
          // Final respond on step 6
          yield {
            type: "tool_call",
            tool_call: {
              id: `tc-final`,
              name: "agent_decide",
              arguments: JSON.stringify({
                observation: "Task complete",
                analysis: "All steps done",
                plan: "Respond with final answer",
                action: "respond",
                content: "Task completed after multiple steps",
                summary: "Multi-step task finished",
              }),
            },
          };
          yield {
            type: "done",
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        }
      });

      mockToolExecute.mockResolvedValue("ok");

      const events = await collectAgentEvents(
        service.run("conv-mem", "Do a complex multi-step task"),
      );

      // Verify agent completed successfully
      const done = events.find((e) => e.type === "agent_done");
      expect(done).toBeDefined();

      // Verify we had 6 iterations (5 tool calls + 1 respond)
      const actEvents = events.filter((e) => e.type === "agent_act");
      expect(actEvents.length).toBeGreaterThanOrEqual(5);

      // Should not have errors
      const errorEvents = events.filter((e) => e.type === "agent_error");
      expect(errorEvents).toHaveLength(0);
    });
  });
});
