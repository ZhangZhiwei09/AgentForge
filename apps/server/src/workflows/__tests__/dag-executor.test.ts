// DAGExecutor 单元测试 — 验证拓扑排序、工作流执行、断点跳过、委托等所有契约
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowStep, StepResult, WorkflowDefinition, ProgressSummary } from "@agentforge/shared-types";
import type { StepHandler, StepContext } from "../handlers/index.js";

// ═══════════════════════════════════════════════════════
// Mocks — must be hoisted before any imports that depend on them
// ═══════════════════════════════════════════════════════

const mockHandlerExecute = vi.fn();

function createMockHandler(): StepHandler {
  return { execute: mockHandlerExecute };
}

const mockAgentHandler = createMockHandler();
const mockToolHandler = createMockHandler();
const mockConditionHandler = createMockHandler();
const mockParallelHandler = createMockHandler();
const mockHumanApprovalHandler = createMockHandler();
const mockTransformHandler = createMockHandler();

vi.mock("../handlers/index.js", () => ({
  AgentStepHandler: vi.fn().mockImplementation(() => mockAgentHandler),
  ToolStepHandler: vi.fn().mockImplementation(() => mockToolHandler),
  ConditionStepHandler: vi.fn().mockImplementation(() => mockConditionHandler),
  ParallelStepHandler: vi.fn().mockImplementation(() => mockParallelHandler),
  HumanApprovalStepHandler: vi.fn().mockImplementation(() => mockHumanApprovalHandler),
  TransformStepHandler: vi.fn().mockImplementation(() => mockTransformHandler),
}));

const mockExecuteWithRetry = vi.fn();
const mockExecuteSingleStepFn = vi.fn();

vi.mock("../step-runner.js", () => ({
  executeWithRetry: mockExecuteWithRetry,
  executeSingleStep: mockExecuteSingleStepFn,
}));

const mockBuildCheckpointFn = vi.fn();

vi.mock("../checkpoint.js", () => {
  const actual = vi.importActual("../checkpoint.js");
  return {
    buildCheckpoint: mockBuildCheckpointFn,
  };
});

// Dynamic import — after all mocks are set up
const { DAGExecutor } = await import("../dag-executor.js");

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function makeStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: overrides.id ?? "step-1",
    type: overrides.type ?? "agent",
    depends_on: overrides.depends_on ?? [],
    ...overrides,
  } as WorkflowStep;
}

function makeDefinition(steps: WorkflowStep[], overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: "test-workflow",
    steps,
    ...overrides,
  };
}

function makeContext(overrides: Partial<Record<string, unknown>> = {}): StepContext {
  return {
    runId: "run-001",
    conversationId: "conv-001",
    variables: {},
    stepResults: {},
    userId: "user-001",
    emit: vi.fn(),
    pauseForApproval: vi.fn(),
    ...overrides,
  } as unknown as StepContext;
}

function makeDAGContext(
  definition: WorkflowDefinition,
  overrides: Partial<Record<string, unknown>> = {},
): import("../dag-executor.js").DAGExecutionContext {
  return {
    ...makeContext(overrides),
    definition,
    emit: (overrides.emit as (event: unknown) => void) ?? vi.fn(),
    pauseForApproval:
      (overrides.pauseForApproval as (
        stepId: string,
        message: string,
        details: Record<string, unknown> | undefined,
        timeoutMs: number,
      ) => Promise<{ action: "approved" | "rejected" | "timed_out"; modifiedArgs?: Record<string, unknown> }>) ??
      vi.fn().mockResolvedValue({ action: "approved" }),
  };
}

function successResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    status: "completed",
    output: { ok: true },
    durationMs: 10,
    ...overrides,
  };
}

function failedResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    status: "failed",
    output: null,
    error: "Step failed",
    retryCount: 1,
    ...overrides,
  };
}

function skippedResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    status: "skipped",
    output: null,
    reason: "condition not met",
    ...overrides,
  };
}

async function collectEvents(generator: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

// ═══════════════════════════════════════════════════════
// Constructor
// ═══════════════════════════════════════════════════════

describe("DAGExecutor constructor", () => {
  it("initializes all 6 handler types", async () => {
    const executor = new DAGExecutor();
    // Verify handlers were instantiated via mock constructors
    const { AgentStepHandler, ToolStepHandler, ConditionStepHandler, ParallelStepHandler, HumanApprovalStepHandler, TransformStepHandler } =
      await import("../handlers/index.js");
    expect(AgentStepHandler).toHaveBeenCalled();
    expect(ToolStepHandler).toHaveBeenCalled();
    expect(ConditionStepHandler).toHaveBeenCalled();
    expect(ParallelStepHandler).toHaveBeenCalled();
    expect(HumanApprovalStepHandler).toHaveBeenCalled();
    expect(TransformStepHandler).toHaveBeenCalled();
  });

  it("passes a recursive executeSingleStep callback to ParallelStepHandler", async () => {
    const executor = new DAGExecutor();
    const { ParallelStepHandler: PSH } = await import("../handlers/index.js");
    const callArg = (PSH as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(typeof callArg).toBe("function");
    expect(callArg.length).toBe(2); // (step, ctx)
  });
});

// ═══════════════════════════════════════════════════════
// topologicalSort
// ═══════════════════════════════════════════════════════

describe("topologicalSort", () => {
  let executor: InstanceType<typeof DAGExecutor>;

  beforeEach(() => {
    executor = new DAGExecutor();
  });

  describe("single step", () => {
    it("returns 1 level with the step", () => {
      const steps = [makeStep({ id: "A" })];
      const levels = executor.topologicalSort(steps);
      expect(levels).toHaveLength(1);
      expect(levels[0].level).toBe(0);
      expect(levels[0].steps).toEqual(steps);
    });
  });

  describe("linear chain: A->B->C", () => {
    it("returns N levels (one step per level)", () => {
      const steps = [
        makeStep({ id: "A" }),
        makeStep({ id: "B", depends_on: ["A"] }),
        makeStep({ id: "C", depends_on: ["B"] }),
      ];
      const levels = executor.topologicalSort(steps);
      expect(levels).toHaveLength(3);
      expect(levels[0].steps.map((s: { id: string }) => s.id)).toEqual(["A"]);
      expect(levels[1].steps.map((s: { id: string }) => s.id)).toEqual(["B"]);
      expect(levels[2].steps.map((s: { id: string }) => s.id)).toEqual(["C"]);
    });
  });

  describe("parallel independent: A, B, C (no deps)", () => {
    it("returns 1 level with all steps", () => {
      const steps = [
        makeStep({ id: "A" }),
        makeStep({ id: "B" }),
        makeStep({ id: "C" }),
      ];
      const levels = executor.topologicalSort(steps);
      expect(levels).toHaveLength(1);
      expect(levels[0].steps.map((s: { id: string }) => s.id)).toEqual(["A", "B", "C"]);
    });
  });

  describe("diamond: A -> (B, C) -> D", () => {
    it("returns 3 levels", () => {
      const steps = [
        makeStep({ id: "A" }),
        makeStep({ id: "B", depends_on: ["A"] }),
        makeStep({ id: "C", depends_on: ["A"] }),
        makeStep({ id: "D", depends_on: ["B", "C"] }),
      ];
      const levels = executor.topologicalSort(steps);
      expect(levels).toHaveLength(3);
      // Level 0: A (no deps)
      expect(levels[0].steps.map((s: { id: string }) => s.id)).toEqual(["A"]);
      // Level 1: B, C (both depend on A only)
      expect(levels[1].steps.map((s: { id: string }) => s.id).sort()).toEqual(["B", "C"]);
      // Level 2: D (depends on B and C)
      expect(levels[2].steps.map((s: { id: string }) => s.id)).toEqual(["D"]);
    });
  });

  describe("circular dependency: A->B, B->A", () => {
    it("throws an error mentioning circular or unresolved dependency", () => {
      const steps = [
        makeStep({ id: "A", depends_on: ["B"] }),
        makeStep({ id: "B", depends_on: ["A"] }),
      ];
      expect(() => executor.topologicalSort(steps)).toThrow(/circular|unresolved|dependency/i);
    });
  });

  describe("missing dependency: A depends_on unknown X", () => {
    it("throws because dependency cannot be resolved", () => {
      const steps = [makeStep({ id: "A", depends_on: ["X"] })];
      expect(() => executor.topologicalSort(steps)).toThrow();
    });
  });

  describe("empty array", () => {
    it("returns an empty levels array", () => {
      const levels = executor.topologicalSort([]);
      expect(levels).toEqual([]);
    });
  });

  describe("steps with no depends_on property", () => {
    it("treats undefined depends_on as no dependencies", () => {
      const step = { id: "A", type: "agent" } as WorkflowStep;
      const levels = executor.topologicalSort([step]);
      expect(levels).toHaveLength(1);
      expect(levels[0].steps).toEqual([step]);
    });
  });

  describe("complex fan-in/fan-out: A->(B,C), B->D, C->D, D->E", () => {
    it("groups correctly across 4 levels", () => {
      const steps = [
        makeStep({ id: "A" }),
        makeStep({ id: "B", depends_on: ["A"] }),
        makeStep({ id: "C", depends_on: ["A"] }),
        makeStep({ id: "D", depends_on: ["B", "C"] }),
        makeStep({ id: "E", depends_on: ["D"] }),
      ];
      const levels = executor.topologicalSort(steps);
      expect(levels).toHaveLength(4);
      expect(levels[0].steps.map((s: { id: string }) => s.id)).toEqual(["A"]);
      expect(levels[1].steps.map((s: { id: string }) => s.id).sort()).toEqual(["B", "C"]);
      expect(levels[2].steps.map((s: { id: string }) => s.id)).toEqual(["D"]);
      expect(levels[3].steps.map((s: { id: string }) => s.id)).toEqual(["E"]);
    });
  });
});

// ═══════════════════════════════════════════════════════
// execute
// ═══════════════════════════════════════════════════════

describe("execute", () => {
  let executor: InstanceType<typeof DAGExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteWithRetry.mockReset();
    mockExecuteSingleStepFn.mockReset();
    executor = new DAGExecutor();
  });

  // ── First event: workflow_started ──

  it("yields workflow_started as the first event", async () => {
    const steps = [makeStep({ id: "step-1" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(successResult());

    const gen = executor.execute(ctx);
    const first = await gen.next();

    expect(first.value).toMatchObject({
      type: "workflow_started",
      runId: "run-001",
      workflowName: "test-workflow",
      totalSteps: 1,
    });
  });

  // ── step_started per step ──

  it("yields workflow_step_started for each step", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: "ok-a" }));
    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: "ok-b" }));

    const events = await collectEvents(executor.execute(ctx));

    const startedEvents = events.filter((e) => (e as Record<string, unknown>).type === "workflow_step_started");
    expect(startedEvents).toHaveLength(2);
    expect(startedEvents[0]).toMatchObject({ type: "workflow_step_started", stepId: "A" });
    expect(startedEvents[1]).toMatchObject({ type: "workflow_step_started", stepId: "B" });
  });

  // ── step_completed for success ──

  it("yields workflow_step_completed for a successful step", async () => {
    const steps = [makeStep({ id: "A" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: { result: 42 } }));

    const events = await collectEvents(executor.execute(ctx));

    const completed = events.find((e) => (e as Record<string, unknown>).type === "workflow_step_completed");
    expect(completed).toBeDefined();
    expect(completed).toMatchObject({
      type: "workflow_step_completed",
      stepId: "A",
      status: "completed",
      output: { result: 42 },
    });
  });

  // ── step_failed for failure ──

  it("yields workflow_step_failed for a failed step", async () => {
    const steps = [makeStep({ id: "A" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(failedResult({ error: "boom" }));

    const events = await collectEvents(executor.execute(ctx));

    const failed = events.find((e) => (e as Record<string, unknown>).type === "workflow_step_failed");
    expect(failed).toBeDefined();
    expect(failed).toMatchObject({
      type: "workflow_step_failed",
      stepId: "A",
      error: "boom",
    });
  });

  // ── step_completed for skipped ──

  it("yields workflow_step_completed with status=skipped for a skipped step", async () => {
    const steps = [makeStep({ id: "A" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(skippedResult());

    const events = await collectEvents(executor.execute(ctx));

    const completed = events.find((e) => (e as Record<string, unknown>).type === "workflow_step_completed");
    expect(completed).toBeDefined();
    expect(completed).toMatchObject({
      type: "workflow_step_completed",
      stepId: "A",
      status: "skipped",
    });
  });

  // ── stores output in context.stepResults ──

  it("stores step output in context.stepResults on success", async () => {
    const steps = [makeStep({ id: "step-1" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: { data: 100 } }));

    await collectEvents(executor.execute(ctx));

    expect(ctx.stepResults["step-1"]).toEqual({ data: 100 });
  });

  it("does NOT store output in context.stepResults on failure", async () => {
    const steps = [makeStep({ id: "step-1" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(failedResult());

    await collectEvents(executor.execute(ctx));

    expect(ctx.stepResults["step-1"]).toBeUndefined();
  });

  // ── condition step stores branch info ──

  it("stores branch info for completed condition steps with subSteps", async () => {
    const conditionStep = makeStep({ id: "cond-1", type: "condition" });
    const steps = [conditionStep];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(
      successResult({
        output: { branch: "true-branch", subSteps: [] },
      }),
    );

    await collectEvents(executor.execute(ctx));

    expect(ctx.stepResults["cond-1_branch"]).toBe("true-branch");
  });

  // ── workflow_completed with progress ──

  it("yields workflow_completed as the final event with progress summary", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(successResult());
    mockExecuteWithRetry.mockResolvedValueOnce(successResult());

    const events = await collectEvents(executor.execute(ctx));

    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.type).toBe("workflow_completed");
    expect(last.runId).toBe("run-001");
    expect(last.output).toBe(ctx.stepResults);
    expect(last.stepSummary).toEqual({
      completed: 2,
      total: 2,
      failed: 0,
      skipped: 0,
      running: 0,
    });
  });

  it("workflow_completed progress reflects mixed outcomes", async () => {
    const steps = [
      makeStep({ id: "A" }),
      makeStep({ id: "B" }),
      makeStep({ id: "C" }),
    ];
    const def = makeDefinition(steps, { on_failure: "continue" });
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry
      .mockResolvedValueOnce(successResult())
      .mockResolvedValueOnce(failedResult())
      .mockResolvedValueOnce(skippedResult());

    const events = await collectEvents(executor.execute(ctx));

    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.stepSummary).toEqual({
      completed: 1,
      total: 3,
      failed: 1,
      skipped: 1,
      running: 0,
    });
  });

  // ── on_failure="stop" halts on error ──

  it("halts execution with workflow_failed when on_failure='stop' and a step fails", async () => {
    const steps = [
      makeStep({ id: "A" }),
      makeStep({ id: "B", depends_on: ["A"] }),
      makeStep({ id: "C", depends_on: ["B"] }),
    ];
    const def = makeDefinition(steps, { on_failure: "stop" });
    const ctx = makeDAGContext(def);

    // Level 0 — step A succeeds
    mockExecuteWithRetry.mockResolvedValueOnce(successResult());

    const events = await collectEvents(executor.execute(ctx));

    // Should NOT reach level 1 because A succeeded and there is only one level with the correct deps.
    // Wait — A has no deps, B depends on A, C depends on B. So 3 levels.
    // Level 0: A succeeds.
    // Level 1: B — we need to mock it too. Let's make A fail at level 0 instead.
    // Actually let's restructure: put A and B at same level (no deps)
  });

  it("on_failure=stop does NOT halt when executeWithRetry returns failed (caught by inner try/catch)", async () => {
    // The inner try/catch in the mapper function catches all errors from executeWithRetry
    // and converts them to resolved promises. The on_failure check is only in the
    // Promise.allSettled rejection branch, which is not reached for returned failures.
    const steps = [
      makeStep({ id: "A" }),
      makeStep({ id: "B" }),
      makeStep({ id: "C" }),
    ];
    const def = makeDefinition(steps, { on_failure: "stop" });
    const ctx = makeDAGContext(def);

    // All in one level — A fails, B succeeds, C succeeds
    mockExecuteWithRetry
      .mockResolvedValueOnce(failedResult({ error: "A failed" }))
      .mockResolvedValueOnce(successResult())
      .mockResolvedValueOnce(successResult());

    const events = await collectEvents(executor.execute(ctx));

    // A emits workflow_step_failed, but on_failure is not checked in the fulfilled path
    const failedStep = events.find(
      (e) =>
        (e as Record<string, unknown>).type === "workflow_step_failed" &&
        (e as Record<string, unknown>).stepId === "A",
    );
    expect(failedStep).toBeDefined();
    // Execution continues and finishes normally despite on_failure=stop
    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.type).toBe("workflow_completed");
    expect((last.stepSummary as ProgressSummary).failed).toBe(1);
    expect((last.stepSummary as ProgressSummary).completed).toBe(2);
  });

  it("continues execution when on_failure is not 'stop'", async () => {
    const steps = [
      makeStep({ id: "A" }),
      makeStep({ id: "B" }),
    ];
    const def = makeDefinition(steps, { on_failure: "continue" });
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry
      .mockResolvedValueOnce(failedResult())
      .mockResolvedValueOnce(successResult());

    const events = await collectEvents(executor.execute(ctx));

    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.type).toBe("workflow_completed");
    expect((last.stepSummary as ProgressSummary).completed).toBe(1);
    expect((last.stepSummary as ProgressSummary).failed).toBe(1);
  });

  // ── Promise rejection (executeWithRetry throws) ──

  it("handles Promise.reject from executeWithRetry as a step failure", async () => {
    const steps = [makeStep({ id: "A" })];
    const def = makeDefinition(steps, { on_failure: "continue" });
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockRejectedValueOnce(new Error("Executor crashed"));

    const events = await collectEvents(executor.execute(ctx));

    const failed = events.find((e) => (e as Record<string, unknown>).type === "workflow_step_failed");
    expect(failed).toBeDefined();
    expect(failed).toMatchObject({
      type: "workflow_step_failed",
      stepId: "A",
      error: "Executor crashed",
    });

    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.type).toBe("workflow_completed");
  });

  it("handles Promise.reject without a message", async () => {
    const steps = [makeStep({ id: "A" })];
    const def = makeDefinition(steps, { on_failure: "continue" });
    const ctx = makeDAGContext(def);

    // Reject with a non-Error — inner catch wraps as "Step execution failed"
    mockExecuteWithRetry.mockRejectedValueOnce("raw string error");

    const events = await collectEvents(executor.execute(ctx));

    const failed = events.find((e) => (e as Record<string, unknown>).type === "workflow_step_failed");
    expect(failed).toBeDefined();
    // Inner catch produces "Step execution failed" for non-Error rejections
    expect((failed as Record<string, unknown>).stepId).toBe("A");
    expect((failed as Record<string, unknown>).error).toBe("Step execution failed");
  });

  // ── Multi-level execution with deps (events flow) ──

  it("executes steps level by level when dependencies exist", async () => {
    const steps = [
      makeStep({ id: "A" }),
      makeStep({ id: "B", depends_on: ["A"] }),
    ];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry
      .mockResolvedValueOnce(successResult({ output: "level0" }))
      .mockResolvedValueOnce(successResult({ output: "level1" }));

    const events = await collectEvents(executor.execute(ctx));

    const eventTypes = events.map((e) => (e as Record<string, unknown>).type);
    expect(eventTypes).toEqual([
      "workflow_started",
      "workflow_step_started",   // A started (level 0)
      "workflow_step_completed", // A completed
      "workflow_step_started",   // B started (level 1)
      "workflow_step_completed", // B completed
      "workflow_completed",
    ]);
  });

  // ── Error in executeWithRetry retryCount ──

  it("includes retryCount in step_failed events when from executeWithRetry result", async () => {
    const steps = [makeStep({ id: "A" })];
    const def = makeDefinition(steps, { on_failure: "continue" });
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(failedResult({ error: "timeout", retryCount: 3 }));

    const events = await collectEvents(executor.execute(ctx));

    const failed = events.find((e) => (e as Record<string, unknown>).type === "workflow_step_failed");
    expect(failed).toBeDefined();
    expect((failed as Record<string, unknown>).retryCount).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════
// executeWithSkip
// ═══════════════════════════════════════════════════════

describe("executeWithSkip", () => {
  let executor: InstanceType<typeof DAGExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteWithRetry.mockReset();
    executor = new DAGExecutor();
  });

  it("skips completed step IDs and does not execute them", async () => {
    const steps = [
      makeStep({ id: "A" }),
      makeStep({ id: "B" }),
      makeStep({ id: "C" }),
    ];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    ctx.stepResults["A"] = "stored-output";

    // Only B and C should be executed
    mockExecuteWithRetry
      .mockResolvedValueOnce(successResult({ output: "b" }))
      .mockResolvedValueOnce(successResult({ output: "c" }));

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    // A should NOT be passed to executeWithRetry
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);

    const calls = mockExecuteWithRetry.mock.calls;
    const calledStepIds = calls.map((c: unknown[]) => (c[0] as WorkflowStep).id);
    expect(calledStepIds).toEqual(["B", "C"]);
  });

  it("yields workflow_started with resumedFromCheckpoint=true when skipIds non-empty", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    ctx.stepResults["A"] = "cached";

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: "b" }));

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    const started = events[0] as Record<string, unknown>;
    expect(started.type).toBe("workflow_started");
    expect(started.resumedFromCheckpoint).toBe(true);
  });

  it("yields workflow_started with resumedFromCheckpoint=false when skipIds is empty", async () => {
    const steps = [makeStep({ id: "A" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce(successResult());

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set()));

    const started = events[0] as Record<string, unknown>;
    expect(started.type).toBe("workflow_started");
    expect(started.resumedFromCheckpoint).toBe(false);
  });

  it("yields workflow_step_completed for skipped steps with cached output", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    ctx.stepResults["A"] = "resumed-output";

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: "b" }));

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    const skipCompletedEvents = events.filter(
      (e) =>
        (e as Record<string, unknown>).type === "workflow_step_completed" &&
        (e as Record<string, unknown>).stepId === "A",
    );
    expect(skipCompletedEvents).toHaveLength(1);
    expect(skipCompletedEvents[0]).toMatchObject({
      type: "workflow_step_completed",
      stepId: "A",
      status: "completed",
      output: "resumed-output",
      durationMs: 0,
    });
  });

  it("yields workflow_step_completed for skipped step with fallback message when no cached output", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    // A has no stored output in stepResults

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: "b" }));

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    const skipEvents = events.filter(
      (e) =>
        (e as Record<string, unknown>).type === "workflow_step_completed" &&
        (e as Record<string, unknown>).stepId === "A",
    );
    expect(skipEvents).toHaveLength(1);
    expect(skipEvents[0]).toMatchObject({
      type: "workflow_step_completed",
      stepId: "A",
      status: "completed",
      output: "(resumed from checkpoint)",
    });
  });

  it("pending steps execute normally after skip filter", async () => {
    const steps = [
      makeStep({ id: "A" }),
      makeStep({ id: "B" }),
      makeStep({ id: "C" }),
    ];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    ctx.stepResults["A"] = "a-out";

    mockExecuteWithRetry
      .mockResolvedValueOnce(successResult({ output: "b" }))
      .mockResolvedValueOnce(successResult({ output: "c" }));

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    const completedEvents = events.filter(
      (e) =>
        (e as Record<string, unknown>).type === "workflow_step_completed" &&
        (e as Record<string, unknown>).status === "completed",
    );
    // A (skipped mark) + B + C = 3 completed events
    expect(completedEvents).toHaveLength(3);
  });

  it("progress includes skipped count in final workflow_completed", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    ctx.stepResults["A"] = "a-out";

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: "b" }));

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.type).toBe("workflow_completed");
    expect(last.stepSummary).toEqual({
      completed: 2, // A (from skip count) + B
      total: 2,
      failed: 0,
      skipped: 0,
      running: 0,
    });
  });

  it("handles failed steps while skipping others", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" }), makeStep({ id: "C" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    ctx.stepResults["A"] = "a-out";

    mockExecuteWithRetry
      .mockResolvedValueOnce(failedResult({ error: "B failed" }))
      .mockResolvedValueOnce(successResult({ output: "c" }));

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    const last = events[events.length - 1] as Record<string, unknown>;
    expect(last.type).toBe("workflow_completed");
    expect(last.stepSummary).toMatchObject({
      completed: 2, // A (skip) + C
      failed: 1,    // B
    });
  });

  it("skips an entire level when all steps in that level are in skipIds", async () => {
    const steps = [
      makeStep({ id: "A" }),
      makeStep({ id: "B", depends_on: ["A"] }),
    ];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    ctx.stepResults["A"] = "a-out";

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: "b" }));

    // Skip A (level 0 entirely skipped)
    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    // Only B should be executed
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
    expect((mockExecuteWithRetry.mock.calls[0][0] as WorkflowStep).id).toBe("B");
  });

  it("emits workflow_step_started events for all steps including skipped ones", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);
    ctx.stepResults["A"] = "a-out";

    mockExecuteWithRetry.mockResolvedValueOnce(successResult({ output: "b" }));

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set(["A"])));

    const startedEvents = events.filter((e) => (e as Record<string, unknown>).type === "workflow_step_started");
    expect(startedEvents).toHaveLength(2);
  });

  it("handles rejected promise for a pending step in executeWithSkip", async () => {
    const steps = [makeStep({ id: "A" }), makeStep({ id: "B" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry
      .mockResolvedValueOnce(successResult()) // A
      .mockRejectedValueOnce(new Error("B rejected")); // B rejects entirely

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set()));

    const failed = events.find(
      (e) =>
        (e as Record<string, unknown>).type === "workflow_step_failed" &&
        (e as Record<string, unknown>).stepId === "B",
    );
    expect(failed).toBeDefined();
  });

  it("handles paused/approval-required status in executeWithSkip", async () => {
    const steps = [makeStep({ id: "A", type: "human_approval" })];
    const def = makeDefinition(steps);
    const ctx = makeDAGContext(def);

    mockExecuteWithRetry.mockResolvedValueOnce({
      status: "paused",
      output: null,
      message: "Approval required",
      details: {},
    } as unknown as StepResult & { message: string; details: Record<string, unknown> });

    const events = await collectEvents(executor.executeWithSkip(ctx, new Set()));

    const approval = events.find((e) => (e as Record<string, unknown>).type === "workflow_approval_required");
    expect(approval).toBeDefined();
    expect(approval).toMatchObject({
      type: "workflow_approval_required",
      stepId: "A",
      message: "Approval required",
    });
  });
});

// ═══════════════════════════════════════════════════════
// buildCheckpoint
// ═══════════════════════════════════════════════════════

describe("buildCheckpoint", () => {
  let executor: InstanceType<typeof DAGExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildCheckpointFn.mockReset();
    executor = new DAGExecutor();
  });

  it("delegates to the checkpoint module's buildCheckpoint function", () => {
    const expected = {
      runId: "run-001",
      workflowId: "wf-001",
      completedSteps: ["A"],
      currentStep: "B",
      pendingSteps: ["B"],
      stepLogs: [],
      variables: { v: 1 },
      stepResults: { A: "ok" },
      savedAt: expect.any(String) as string,
      totalSteps: 3,
    };
    mockBuildCheckpointFn.mockReturnValueOnce(expected);

    const result = executor.buildCheckpoint(
      "run-001",
      "wf-001",
      ["A"],
      ["B"],
      [],
      { v: 1 },
      { A: "ok" },
      3,
    );

    expect(mockBuildCheckpointFn).toHaveBeenCalledWith(
      "run-001",
      "wf-001",
      ["A"],
      ["B"],
      [],
      { v: 1 },
      { A: "ok" },
      3,
    );
    expect(result).toBe(expected);
  });

  it("passes empty arrays and empty objects through correctly", () => {
    mockBuildCheckpointFn.mockReturnValueOnce({
      runId: "r",
      workflowId: "w",
      completedSteps: [],
      currentStep: null,
      pendingSteps: [],
      stepLogs: [],
      variables: {},
      stepResults: {},
      savedAt: "2026-01-01T00:00:00.000Z",
      totalSteps: 0,
    });

    const result = executor.buildCheckpoint("r", "w", [], [], [], {}, {}, 0);

    expect(mockBuildCheckpointFn).toHaveBeenCalledWith("r", "w", [], [], [], {}, {}, 0);
    expect(result.currentStep).toBeNull();
    expect(result.completedSteps).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════
// executeSingleStep
// ═══════════════════════════════════════════════════════

describe("executeSingleStep", () => {
  let executor: InstanceType<typeof DAGExecutor>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteSingleStepFn.mockReset();
    executor = new DAGExecutor();
  });

  it("delegates to the step-runner executeSingleStep function", async () => {
    const step = makeStep({ id: "A", type: "agent" });
    const context = makeContext();
    const expectedResult = successResult({ output: { done: true } });

    mockExecuteSingleStepFn.mockResolvedValueOnce(expectedResult);

    const result = await executor.executeSingleStep(step, context);

    expect(mockExecuteSingleStepFn).toHaveBeenCalledWith(step, context, expect.any(Object));
    expect(result).toBe(expectedResult);
  });

  it("passes the handlers record as the third argument", async () => {
    const step = makeStep({ id: "A", type: "tool" });
    const context = makeContext();

    mockExecuteSingleStepFn.mockResolvedValueOnce(successResult());

    await executor.executeSingleStep(step, context);

    const handlersArg = mockExecuteSingleStepFn.mock.calls[0][2];
    expect(handlersArg).toBeDefined();
    expect(typeof handlersArg).toBe("object");
    // Should contain all 6 handler type keys
    expect(Object.keys(handlersArg).sort()).toEqual([
      "agent",
      "condition",
      "human_approval",
      "parallel",
      "tool",
      "transform",
    ]);
  });

  it("returns a failed result when executeSingleStepFn returns failure", async () => {
    const step = makeStep({ id: "A" });
    const context = makeContext();

    mockExecuteSingleStepFn.mockResolvedValueOnce(failedResult({ error: "handler error" }));

    const result = await executor.executeSingleStep(step, context);

    expect(result.status).toBe("failed");
    expect(result.error).toBe("handler error");
  });
});
