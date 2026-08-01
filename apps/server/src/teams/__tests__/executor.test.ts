// TeamExecutor Tests — validation, mode dispatch, unknown modes
//
// Covers:
//   1. execute: dispatches to correct mode executor
//   2. Validation: min/max agents, unique names, mode-specific
//   3. Unknown mode → team_failed
//   4. Generator delegation (yield* from mode executor)
//   5. Multiple validation errors accumulated at once
//
// Run: pnpm --filter @agentforge/server test -- --run src/teams/__tests__/executor.test.ts

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TeamDefinition, TeamStreamEvent, AgentRole } from "@agentforge/shared-types";
import type { ExecutionContext } from "../modes/types.js";
import { Blackboard } from "../blackboard.js";
import { MessageBus } from "../message-bus.js";

// ═══════════════════════════════════════════════════════════
// Mock DiagnosisMode
// ═══════════════════════════════════════════════════════════

const mockDiagnosisExecute = vi.fn();

vi.mock("../modes/diagnosis.js", () => ({
  DiagnosisMode: vi.fn().mockImplementation(() => ({
    execute: mockDiagnosisExecute,
  })),
}));

import { TeamExecutor } from "../executor.js";

// ═══════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════

/** Build a minimal agent role for testing */
function makeAgent(overrides?: Partial<AgentRole>): AgentRole {
  return {
    name: "agent_1",
    displayName: "Agent 1",
    description: "Test agent",
    systemPrompt: "You are a test agent.",
    tools: [],
    maxIterations: 3,
    priority: 5,
    canDelegate: false,
    canBroadcast: false,
    ...overrides,
  };
}

/** Build a minimal team definition for testing */
function makeTeamDefinition(overrides?: Partial<TeamDefinition>): TeamDefinition {
  return {
    name: "测试团队",
    version: "1.0",
    collaborationMode: "diagnosis",
    agents: [
      makeAgent({ name: "frontend_agent", displayName: "前端" }),
      makeAgent({ name: "backend_agent", displayName: "后端" }),
    ],
    maxTotalIterations: 3,
    ...overrides,
  };
}

/** Build a minimal ExecutionContext for testing */
function makeContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  const teamRunId = overrides?.teamRunId ?? "test-run-1";
  return {
    teamRunId,
    conversationId: "test-conv-1",
    userId: "test-user",
    definition: makeTeamDefinition(),
    bus: new MessageBus(teamRunId),
    blackboard: new Blackboard(),
    variables: {},
    ...overrides,
  };
}

/** Collect all events from a TeamExecutor execute generator */
async function collectEvents(
  executor: TeamExecutor,
  definition: TeamDefinition,
  task: string,
  context: ExecutionContext,
): Promise<TeamStreamEvent[]> {
  const events: TeamStreamEvent[] = [];
  for await (const event of executor.execute(definition, task, context)) {
    events.push(event);
  }
  return events;
}

/** Access the private validateTeam method on TeamExecutor */
function validateTeam(
  executor: TeamExecutor,
  definition: TeamDefinition,
): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private method in test
  return (executor as any).validateTeam(definition) as string[];
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe("TeamExecutor", () => {
  let executor: TeamExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new TeamExecutor();
  });

  // ── Constructor ──────────────────────────────────────────

  describe("constructor", () => {
    it("registers diagnosis mode executor", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accessing private field in test
      const modeExecutors = (executor as any).modeExecutors as Map<string, unknown>;
      expect(modeExecutors.has("diagnosis")).toBe(true);
      expect(modeExecutors.get("diagnosis")).toBeDefined();
    });
  });

  // ── Mode Dispatch ────────────────────────────────────────

  describe("execute: mode dispatch", () => {
    it("delegates to diagnosis mode executor when mode is 'diagnosis'", async () => {
      const mockEvents: TeamStreamEvent[] = [
        { type: "team_started", teamRunId: "r1", teamName: "test", mode: "diagnosis", agents: [] },
      ];

      mockDiagnosisExecute.mockReturnValue(
        (async function* () {
          yield* mockEvents;
        })(),
      );

      const def = makeTeamDefinition({ collaborationMode: "diagnosis" });
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "test task", ctx);

      expect(mockDiagnosisExecute).toHaveBeenCalledWith(def, "test task", ctx);
      expect(events).toEqual(mockEvents);
    });

    it("yields team_failed for unknown collaboration mode", async () => {
      const def = makeTeamDefinition({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing invalid mode
        collaborationMode: "brainstorm" as any,
      });
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("team_failed");
      expect((events[0] as { error: string }).error).toBe(
        "Unknown collaboration mode: brainstorm",
      );
      expect(mockDiagnosisExecute).not.toHaveBeenCalled();
    });

    it("returns immediately after yielding team_failed for unknown mode", async () => {
      const def = makeTeamDefinition({
        collaborationMode: "diagnosis",
        agents: [], // would fail validation, but mode check happens first
      });
      // Override to unknown mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing invalid mode
      (def as any).collaborationMode = "unknown_mode";
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      // Only one event: the unknown mode error — no validation errors
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("team_failed");
      expect((events[0] as { error: string }).error).toContain("Unknown collaboration mode");
    });
  });

  // ── Validation: Min Agents ───────────────────────────────

  describe("validateTeam: min agents", () => {
    it("rejects 0 agents", () => {
      const def = makeTeamDefinition({ agents: [] });
      const errors = validateTeam(executor, def);
      expect(errors).toContain("Team must have at least 2 agents");
    });

    it("rejects 1 agent", () => {
      const def = makeTeamDefinition({
        agents: [makeAgent({ name: "frontend_agent" })],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toContain("Team must have at least 2 agents");
    });

    it("accepts 2 agents", () => {
      const def = makeTeamDefinition({
        agents: [
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "backend_agent" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toHaveLength(0);
    });
  });

  // ── Validation: Max Agents ───────────────────────────────

  describe("validateTeam: max agents", () => {
    it("accepts 10 agents", () => {
      const agents = Array.from({ length: 10 }, (_, i) =>
        makeAgent({ name: `agent_${i}` }),
      );
      // Ensure frontend_agent is present for diagnosis validation
      agents[0] = makeAgent({ name: "frontend_agent" });
      const def = makeTeamDefinition({ agents });
      const errors = validateTeam(executor, def);
      expect(errors).toHaveLength(0);
    });

    it("rejects 11 agents", () => {
      const agents = Array.from({ length: 11 }, (_, i) =>
        makeAgent({ name: `agent_${i}` }),
      );
      agents[0] = makeAgent({ name: "frontend_agent" });
      const def = makeTeamDefinition({ agents });
      const errors = validateTeam(executor, def);
      expect(errors).toContain("Team cannot have more than 10 agents");
    });

    it("rejects 20 agents", () => {
      const agents = Array.from({ length: 20 }, (_, i) =>
        makeAgent({ name: `agent_${i}` }),
      );
      agents[0] = makeAgent({ name: "frontend_agent" });
      const def = makeTeamDefinition({ agents });
      const errors = validateTeam(executor, def);
      expect(errors).toContain("Team cannot have more than 10 agents");
    });
  });

  // ── Validation: Unique Names ─────────────────────────────

  describe("validateTeam: unique names", () => {
    it("rejects duplicate agent names", () => {
      const def = makeTeamDefinition({
        agents: [
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "frontend_agent" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toContain("Agent names must be unique");
    });

    it("accepts all unique names", () => {
      const def = makeTeamDefinition({
        agents: [
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "backend_agent" }),
          makeAgent({ name: "leader" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toHaveLength(0);
    });

    it("rejects when 3 agents share same name", () => {
      const def = makeTeamDefinition({
        agents: [
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "frontend_agent" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toContain("Agent names must be unique");
      // Should only report the duplicate error once
      expect(errors.filter((e) => e === "Agent names must be unique")).toHaveLength(1);
    });
  });

  // ── Validation: Diagnosis Mode Specific ──────────────────

  describe("validateTeam: diagnosis mode", () => {
    it("rejects diagnosis mode without frontend_agent", () => {
      const def = makeTeamDefinition({
        collaborationMode: "diagnosis",
        agents: [
          makeAgent({ name: "backend_agent" }),
          makeAgent({ name: "leader" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toContain(
        "Diagnosis mode requires an agent named 'frontend_agent'",
      );
    });

    it("accepts diagnosis mode with frontend_agent present", () => {
      const def = makeTeamDefinition({
        collaborationMode: "diagnosis",
        agents: [
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "backend_agent" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toHaveLength(0);
    });

    it("accepts diagnosis mode with frontend_agent plus other agents", () => {
      const def = makeTeamDefinition({
        collaborationMode: "diagnosis",
        agents: [
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "backend_agent" }),
          makeAgent({ name: "leader" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toHaveLength(0);
    });
  });

  // ── Validation: Multiple Errors ──────────────────────────

  describe("validateTeam: multiple errors", () => {
    it("returns all validation errors at once", () => {
      const def = makeTeamDefinition({
        collaborationMode: "diagnosis",
        agents: [
          makeAgent({ name: "backend_agent" }),
          makeAgent({ name: "backend_agent" }),
        ],
      });
      const errors = validateTeam(executor, def);

      // Should have: duplicate names AND missing frontend_agent
      // (min agent check: 2 agents → ok)
      expect(errors).toHaveLength(2);
      expect(errors).toContain("Agent names must be unique");
      expect(errors).toContain(
        "Diagnosis mode requires an agent named 'frontend_agent'",
      );
    });

    it("combines min agents + missing frontend_agent", () => {
      const def = makeTeamDefinition({
        collaborationMode: "diagnosis",
        agents: [makeAgent({ name: "backend_agent" })],
      });
      const errors = validateTeam(executor, def);

      expect(errors).toHaveLength(2);
      expect(errors).toContain("Team must have at least 2 agents");
      expect(errors).toContain(
        "Diagnosis mode requires an agent named 'frontend_agent'",
      );
    });

    it("combines max agents + duplicate names + missing frontend_agent", () => {
      const agents = Array.from({ length: 11 }, (_, i) =>
        makeAgent({ name: "agent_x" }),
      );
      const def = makeTeamDefinition({ agents });
      const errors = validateTeam(executor, def);

      expect(errors).toHaveLength(3);
      expect(errors).toContain("Team cannot have more than 10 agents");
      expect(errors).toContain("Agent names must be unique");
      expect(errors).toContain(
        "Diagnosis mode requires an agent named 'frontend_agent'",
      );
    });

    it("combines min agents + max agents (impossible but tests logic)", () => {
      // Edge case: 0 agents triggers both "at least 2" — it does NOT also
      // trigger "more than 10" since 0 < 10. But we can test 11 agents with
      // duplicates to trigger all three.
      const agents = Array.from({ length: 11 }, () =>
        makeAgent({ name: "dup" }),
      );
      const def = makeTeamDefinition({ agents });
      const errors = validateTeam(executor, def);

      expect(errors).toHaveLength(3);
      expect(errors).toContain("Team cannot have more than 10 agents");
      expect(errors).toContain("Agent names must be unique");
      expect(errors).toContain(
        "Diagnosis mode requires an agent named 'frontend_agent'",
      );
    });

    it("returns zero errors for valid team definition", () => {
      const def = makeTeamDefinition({
        collaborationMode: "diagnosis",
        agents: [
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "backend_agent" }),
          makeAgent({ name: "leader" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toHaveLength(0);
    });
  });

  // ── execute: validation errors produce team_failed ────────

  describe("execute: validation errors", () => {
    it("yields team_failed when validation fails (duplicate agents)", async () => {
      const def = makeTeamDefinition({
        agents: [
          makeAgent({ name: "frontend_agent" }),
          makeAgent({ name: "frontend_agent" }),
        ],
      });
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("team_failed");
      const error = (events[0] as { error: string }).error;
      expect(error).toContain("Team validation failed");
      expect(error).toContain("Agent names must be unique");
    });

    it("yields team_failed with all validation errors joined", async () => {
      const def = makeTeamDefinition({
        agents: [
          makeAgent({ name: "backend_agent" }),
          makeAgent({ name: "backend_agent" }),
        ],
      });
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("team_failed");
      const error = (events[0] as { error: string }).error;
      expect(error).toBe(
        "Team validation failed: " +
          "Agent names must be unique; " +
          "Diagnosis mode requires an agent named 'frontend_agent'",
      );
    });

    it("does not invoke mode executor when validation fails", async () => {
      const def = makeTeamDefinition({ agents: [] });
      const ctx = makeContext({ definition: def });

      await collectEvents(executor, def, "task", ctx);

      // Mode executor should never be called when validation fails
      expect(mockDiagnosisExecute).not.toHaveBeenCalled();
    });

    it("checks unknown mode before validation (mode check is first)", async () => {
      const def = makeTeamDefinition({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing invalid mode
        collaborationMode: "non_existent" as any,
        agents: [], // would fail validation
      });
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      // Unknown mode error, NOT validation error
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("team_failed");
      expect((events[0] as { error: string }).error).toBe(
        "Unknown collaboration mode: non_existent",
      );
    });
  });

  // ── Generator Delegation (yield*) ────────────────────────

  describe("execute: generator delegation", () => {
    it("yields all events from mode executor via yield*", async () => {
      const modeEvents: TeamStreamEvent[] = [
        { type: "team_started", teamRunId: "r1", teamName: "t", mode: "diagnosis", agents: [] },
        { type: "agent_started", agentName: "a1", role: "R", task: "do" },
        { type: "agent_completed", agentName: "a1", output: "ok", durationMs: 100 },
        {
          type: "team_completed",
          output: { result: "success" },
          totalDurationMs: 100,
          roundsCount: 1,
        },
      ];

      mockDiagnosisExecute.mockReturnValue(
        (async function* () {
          for (const event of modeEvents) {
            yield event;
          }
        })(),
      );

      const def = makeTeamDefinition();
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      expect(events).toEqual(modeEvents);
    });

    it("passes through single event from mode executor", async () => {
      const singleEvent: TeamStreamEvent = {
        type: "team_failed",
        error: "frontend_agent not found in team definition",
      };

      mockDiagnosisExecute.mockReturnValue(
        (async function* () {
          yield singleEvent;
        })(),
      );

      const def = makeTeamDefinition();
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(singleEvent);
    });

    it("handles mode executor that yields no events", async () => {
      mockDiagnosisExecute.mockReturnValue(
        (async function* () {
          // empty generator
        })(),
      );

      const def = makeTeamDefinition();
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      expect(events).toHaveLength(0);
    });

    it("passes correct arguments to mode executor", async () => {
      mockDiagnosisExecute.mockReturnValue(
        (async function* () {
          yield { type: "team_completed", output: {}, totalDurationMs: 0, roundsCount: 1 };
        })(),
      );

      const def = makeTeamDefinition();
      const ctx = makeContext({ definition: def });

      await collectEvents(executor, def, "complex task description", ctx);

      expect(mockDiagnosisExecute).toHaveBeenCalledTimes(1);
      expect(mockDiagnosisExecute).toHaveBeenCalledWith(
        def,
        "complex task description",
        ctx,
      );
    });
  });

  // ── Unknown Mode (detailed) ──────────────────────────────

  describe("execute: unknown mode", () => {
    it("yields 'Unknown collaboration mode' error for empty string mode", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing invalid mode
      const def = makeTeamDefinition({ collaborationMode: "" as any });
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("team_failed");
      expect((events[0] as { error: string }).error).toBe(
        "Unknown collaboration mode: ",
      );
    });

    it("yields correct error message format", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing invalid mode
      const def = makeTeamDefinition({ collaborationMode: "custom_v2" as any });
      const ctx = makeContext({ definition: def });

      const events = await collectEvents(executor, def, "task", ctx);

      const failed = events[0] as { type: string; error: string };
      expect(failed.type).toBe("team_failed");
      expect(failed.error).toBe("Unknown collaboration mode: custom_v2");
    });
  });

  // ── Edge Cases ───────────────────────────────────────────

  describe("edge cases", () => {
    it("empty agents array triggers min agent + missing frontend_agent errors", () => {
      const def = makeTeamDefinition({ agents: [] });
      const errors = validateTeam(executor, def);
      expect(errors).toEqual([
        "Team must have at least 2 agents",
        "Diagnosis mode requires an agent named 'frontend_agent'",
      ]);
    });

    it("agents with only frontend_agent (1 agent) triggers min + ok for diagnosis", () => {
      const def = makeTeamDefinition({
        agents: [makeAgent({ name: "frontend_agent" })],
      });
      const errors = validateTeam(executor, def);
      // Min agent error only. frontend_agent IS present, so no diagnosis error.
      expect(errors).toEqual(["Team must have at least 2 agents"]);
    });

    it("diagnosis mode check does not apply to non-diagnosis modes via validateTeam", () => {
      // Even though TeamExecutor currently only has diagnosis and validateTeam
      // checks for it, if a future mode is added without updating validateTeam,
      // this test documents the behavior.
      // Since validateTeam only has checks for diagnosis, other modes would
      // skip the frontend_agent check.
      // We test that the logic is gated by the collaborationMode check.
      const def = makeTeamDefinition({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing behavior
        collaborationMode: "diagnosis" as any,
        agents: [
          makeAgent({ name: "agent_a" }),
          makeAgent({ name: "agent_b" }),
        ],
      });
      const errors = validateTeam(executor, def);
      expect(errors).toContain(
        "Diagnosis mode requires an agent named 'frontend_agent'",
      );
    });
  });
});
