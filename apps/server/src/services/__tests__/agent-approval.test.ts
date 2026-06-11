// AgentService P1-5 Approval Gate Tests
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Hoisted mock refs ----
const {
  mockAgentStreamChat,
  mockToolExecute,
  mockToolListNames,
  mockToolGetDefinitions,
  mockToolGetAll,
  mockTruncateHistory,
} = vi.hoisted(() => ({
  mockAgentStreamChat: vi.fn(),
  mockToolExecute: vi.fn(async () => "tool result"),
  mockToolListNames: vi.fn(() => ["file_write", "calculator"]),
  mockToolGetDefinitions: vi.fn(() => []),
  mockToolGetAll: vi.fn(() => [
    {
      definition: { type: "function", function: { name: "file_write", description: "", parameters: {} } },
      execute: mockToolExecute,
      riskLevel: "destructive",
      timeout: 10000,
      requireApproval: true,
      category: "file",
      parallelizable: false,
    },
    {
      definition: { type: "function", function: { name: "calculator", description: "", parameters: {} } },
      execute: mockToolExecute,
      riskLevel: "safe",
      timeout: 5000,
      requireApproval: false,
      category: "utility",
      parallelizable: true,
    },
  ]),
  mockTruncateHistory: vi.fn((msgs: Array<unknown>) => msgs),
}));

// ---- Mocks ----

vi.mock("../../providers/registry.js", () => ({
  getProvider: vi.fn(() => ({
    streamChat: mockAgentStreamChat,
    chatSync: vi.fn(),
    listModels: vi.fn(() => [{ id: "gpt-4o", name: "GPT-4o", provider: "openai", max_tokens: 128000 }]),
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
    getAll: mockToolGetAll,
  },
}));

vi.mock("../../lib/context-window.js", () => ({
  truncateHistory: mockTruncateHistory,
  estimateTokenCount: vi.fn(() => 100),
}));

vi.mock("../../lib/json-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/json-utils.js")>("../../lib/json-utils.js");
  return actual;
});

vi.mock("@agentforge/shared-prompts", () => ({
  react_system_prompt: { content: "You are a helpful agent. Use agent_decide for decisions." },
}));

// Mock prisma with agentApproval support
const conversationStore = new Map<string, Record<string, unknown>>();
const messageStore = new Map<string, Array<Record<string, unknown>>>();
const sessionStore = new Map<string, Record<string, unknown>>();
const approvalStore = new Map<string, Record<string, unknown>>();

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
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        sessionStore.set(args.create.id as string, args.create);
        return args.create;
      }),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return sessionStore.get(args.where.id) || null;
      }),
    },
    agentApproval: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        approvalStore.set(args.data.id as string, args.data);
        return args.data;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return approvalStore.get(args.where.id) || null;
      }),
      findFirst: vi.fn(async (args: { where: { id?: string; sessionId?: string } }) => {
        if (args.where.id) return approvalStore.get(args.where.id) || null;
        return null;
      }),
      findMany: vi.fn(async () => []),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const existing = approvalStore.get(args.where.id);
        if (existing) {
          const updated = { ...existing, ...args.data };
          approvalStore.set(args.where.id, updated);
          return updated;
        }
        return null;
      }),
    },
    $connect: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

import { AgentService } from "../agent.js";
import type { AgentStreamEvent } from "@agentforge/shared-types";

describe("AgentService — Approval Gate (P1-5)", () => {
  let service: AgentService;

  beforeEach(() => {
    service = new AgentService();
    conversationStore.clear();
    messageStore.clear();
    sessionStore.clear();
    approvalStore.clear();
    vi.clearAllMocks();

    conversationStore.set("conv-agent", {
      id: "conv-agent",
      userId: "user-agent",
      title: "Agent Test",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  async function collectAgentEvents(
    gen: AsyncGenerator<AgentStreamEvent>,
  ): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    for await (const event of gen) {
      events.push(event);
    }
    return events;
  }

  // Helper: create an LLM response that decides on a tool_call
  function createToolCallStream(toolName: string, args: Record<string, unknown>, reason: string) {
    const agentDecideArgs = JSON.stringify({
      observation: "Need to write a file",
      analysis: "User requested file output",
      plan: `Call ${toolName} to complete the task`,
      action: "tool_call",
      tool: toolName,
      args_json: JSON.stringify(args),
      reason,
    });

    return (async function* () {
      yield {
        type: "tool_call" as const,
        tool_call: { id: "tc1", name: "agent_decide", arguments: agentDecideArgs },
      };
    })();
  }

  // Helper: create an LLM response that decides to respond
  function createRespondStream(content: string) {
    const agentDecideArgs = JSON.stringify({
      observation: "Task is complete",
      analysis: "All done",
      plan: "No further steps",
      action: "respond",
      content,
      summary: "Completed",
    });

    return (async function* () {
      yield {
        type: "tool_call" as const,
        tool_call: { id: "tc1", name: "agent_decide", arguments: agentDecideArgs },
      };
    })();
  }

  it("should yield agent_approval_required for tools with requireApproval=true", async () => {
    mockAgentStreamChat.mockReturnValueOnce(
      createToolCallStream("file_write", { path: "/tmp/test.txt", content: "hello" }, "User wants to save output"),
    );

    const gen = service.run("conv-agent", "Write hello to /tmp/test.txt");
    const events = await collectAgentEvents(gen);

    // Should contain agent_approval_required
    const approvalEvent = events.find((e) => e.type === "agent_approval_required");
    expect(approvalEvent).toBeDefined();
    expect(approvalEvent).toMatchObject({
      type: "agent_approval_required",
      tool_name: "file_write",
      risk_level: "destructive",
    });

    // Should NOT contain agent_observe (tool not executed)
    const observeEvent = events.find((e) => e.type === "agent_observe");
    expect(observeEvent).toBeUndefined();

    // Should NOT contain agent_done
    const doneEvent = events.find((e) => e.type === "agent_done");
    expect(doneEvent).toBeUndefined();

    // Should contain agent_meta and agent_think/agent_act
    expect(events.some((e) => e.type === "agent_meta")).toBe(true);
    expect(events.some((e) => e.type === "agent_think")).toBe(true);
    expect(events.some((e) => e.type === "agent_act")).toBe(true);

    // Should have a saved approval record
    expect(approvalStore.size).toBe(1);
    const approval = approvalStore.values().next().value as Record<string, unknown>;
    expect(approval.toolName).toBe("file_write");
    expect(approval.status).toBe("pending");
    expect(approval.riskLevel).toBe("destructive");
  });

  it("should execute tool directly when requireApproval=false", async () => {
    mockAgentStreamChat.mockReturnValueOnce(
      createToolCallStream("calculator", { expression: "2+2" }, "Calculate the result"),
    );

    mockToolExecute.mockResolvedValueOnce("4");

    const gen = service.run("conv-agent", "Calculate 2+2");
    const events = await collectAgentEvents(gen);

    // Should NOT contain agent_approval_required
    expect(events.find((e) => e.type === "agent_approval_required")).toBeUndefined();

    // Should contain agent_observe with the result
    const observeEvent = events.find((e) => e.type === "agent_observe");
    expect(observeEvent).toBeDefined();
    expect(observeEvent).toMatchObject({
      type: "agent_observe",
      result: "4",
    });

    // No approval record should be created
    expect(approvalStore.size).toBe(0);
  });

  it("should handle approval timeout in handleApproval", async () => {
    // Create a paused session + pending approval (timed out)
    const sessionId = "session-timed-out";
    const approvalId = "approval-timed-out";

    sessionStore.set(sessionId, {
      id: sessionId,
      conversationId: "conv-agent",
      task: "Write a file",
      status: "paused",
      scratchpad: [
        {
          step: 1,
          observation: "Need to write a file",
          analysis: "User requested",
          plan: "Use file_write",
          decision: {
            action: "tool_call",
            tool: "file_write",
            args: { path: "/tmp/test.txt", content: "hello" },
            reason: "User requested",
          },
          result: undefined,
          timestamp: new Date().toISOString(),
        },
      ],
      finalSummary: null,
      startedAt: new Date(),
      completedAt: null,
    });

    // Create approval record with past timestamps (simulating timeout)
    approvalStore.set(approvalId, {
      id: approvalId,
      sessionId,
      conversationId: "conv-agent",
      stepNumber: 1,
      toolName: "file_write",
      toolArgs: { path: "/tmp/test.txt", content: "hello" },
      riskLevel: "destructive",
      reason: "User requested",
      status: "pending",
      timeoutMs: 100, // Very short timeout to trigger
      requestedAt: new Date(Date.now() - 200000), // 200 seconds ago
    });

    const gen = service.handleApproval(sessionId, approvalId, "approve");
    const events = await collectAgentEvents(gen);

    // Should yield timed_out approval result
    const result = events.find((e) => e.type === "agent_approval_result");
    expect(result).toBeDefined();
    if (result && result.type === "agent_approval_result") {
      expect(result.status).toBe("timed_out");
    }

    // Approval should be marked timed_out
    const updated = approvalStore.get(approvalId) as Record<string, unknown>;
    expect(updated.status).toBe("timed_out");
  });

  it("should execute tool on approval and continue agent loop", async () => {
    const sessionId = "session-approve";
    const approvalId = "approval-approve";

    sessionStore.set(sessionId, {
      id: sessionId,
      conversationId: "conv-agent",
      task: "Write a file",
      status: "paused",
      scratchpad: [
        {
          step: 1,
          observation: "Need to write a file",
          analysis: "User requested",
          plan: "Use file_write",
          decision: {
            action: "tool_call",
            tool: "file_write",
            args: { path: "/tmp/test.txt", content: "hello" },
            reason: "User requested",
          },
          result: undefined,
          timestamp: new Date().toISOString(),
        },
      ],
      finalSummary: null,
      startedAt: new Date(),
      completedAt: null,
    });

    approvalStore.set(approvalId, {
      id: approvalId,
      sessionId,
      conversationId: "conv-agent",
      stepNumber: 1,
      toolName: "file_write",
      toolArgs: { path: "/tmp/test.txt", content: "hello" },
      riskLevel: "destructive",
      reason: "User requested",
      status: "pending",
      timeoutMs: 300000,
      requestedAt: new Date(),
    });

    // Next LLM call: agent decides to respond
    mockAgentStreamChat.mockReturnValueOnce(
      createRespondStream("File written successfully!"),
    );
    mockToolExecute.mockResolvedValueOnce("File written to /tmp/test.txt");

    const gen = service.handleApproval(sessionId, approvalId, "approve");
    const events = await collectAgentEvents(gen);

    // Should contain approval result
    const approvalResult = events.find((e) => e.type === "agent_approval_result");
    expect(approvalResult).toBeDefined();
    if (approvalResult && approvalResult.type === "agent_approval_result") {
      expect(approvalResult.status).toBe("approved");
    }

    // Should contain agent_observe (tool executed)
    const observe = events.find((e) => e.type === "agent_observe");
    expect(observe).toBeDefined();

    // Should contain agent_respond and agent_done (loop continued)
    expect(events.some((e) => e.type === "agent_respond")).toBe(true);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);
  });

  it("should record rejection on reject and continue", async () => {
    const sessionId = "session-reject";
    const approvalId = "approval-reject";

    sessionStore.set(sessionId, {
      id: sessionId,
      conversationId: "conv-agent",
      task: "Write a file",
      status: "paused",
      scratchpad: [
        {
          step: 1,
          observation: "Need to write a file",
          analysis: "User requested",
          plan: "Use file_write",
          decision: {
            action: "tool_call",
            tool: "file_write",
            args: { path: "/tmp/test.txt", content: "hello" },
            reason: "User requested",
          },
          result: undefined,
          timestamp: new Date().toISOString(),
        },
      ],
      finalSummary: null,
      startedAt: new Date(),
      completedAt: null,
    });

    approvalStore.set(approvalId, {
      id: approvalId,
      sessionId,
      conversationId: "conv-agent",
      stepNumber: 1,
      toolName: "file_write",
      toolArgs: { path: "/tmp/test.txt", content: "hello" },
      riskLevel: "destructive",
      reason: "User requested",
      status: "pending",
      timeoutMs: 300000,
      requestedAt: new Date(),
    });

    // Next LLM decides to respond (after rejection)
    mockAgentStreamChat.mockReturnValueOnce(
      createRespondStream("I couldn't write the file because you rejected the operation."),
    );

    const gen = service.handleApproval(sessionId, approvalId, "reject", undefined, "Don't write to /tmp");
    const events = await collectAgentEvents(gen);

    // Should contain approval result with rejection
    const approvalResult = events.find((e) => e.type === "agent_approval_result");
    expect(approvalResult).toBeDefined();
    if (approvalResult && approvalResult.type === "agent_approval_result") {
      expect(approvalResult.status).toBe("rejected");
    }

    // Should continue loop and complete
    expect(events.some((e) => e.type === "agent_respond")).toBe(true);
    expect(events.some((e) => e.type === "agent_done")).toBe(true);

    // Tool should NOT have been executed
    expect(mockToolExecute).not.toHaveBeenCalled();

    // Approval should be marked rejected
    const updated = approvalStore.get(approvalId) as Record<string, unknown>;
    expect(updated.status).toBe("rejected");
  });

  it("should return agent_error for non-paused session", async () => {
    sessionStore.set("session-running", {
      id: "session-running",
      conversationId: "conv-agent",
      task: "Task",
      status: "running",
      scratchpad: [],
      finalSummary: null,
      startedAt: new Date(),
      completedAt: null,
    });

    const gen = service.handleApproval("session-running", "any-id", "approve");
    const events = await collectAgentEvents(gen);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_error",
      error: "Session is running, not paused",
    });
  });
});
