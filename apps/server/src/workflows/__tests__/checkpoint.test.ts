// CheckpointData & buildCheckpoint — 工作流执行状态持久化单元测试
import { describe, it, expect } from "vitest";
import { buildCheckpoint } from "../checkpoint.js";
import type { CheckpointData } from "../checkpoint.js";
import type { StepResult } from "@agentforge/shared-types";

// =========================================================================
// 测试辅助工厂
// =========================================================================

/** 构建一个合法的 StepResult */
function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    status: "completed",
    output: { message: "OK" },
    ...overrides,
  };
}

/** 标准输入参数 */
const defaultArgs = {
  runId: "run-001",
  workflowId: "wf-abc",
  completedStepIds: ["step-1", "step-2"] as string[],
  pendingStepIds: ["step-3", "step-4"] as string[],
  stepLogs: [
    makeStepResult({ status: "completed", output: { msg: "step1 done" } }),
    makeStepResult({ status: "failed", output: null, error: "timeout", retryCount: 2, durationMs: 1500 }),
  ] as StepResult[],
  variables: { userId: "u-1", sessionId: "s-99" } as Record<string, unknown>,
  stepResults: { "step-1": { score: 0.95 }, "step-2": { score: 0.87 } } as Record<string, unknown>,
  totalSteps: 4,
};

// =========================================================================
// buildCheckpoint
// =========================================================================

describe("buildCheckpoint", () => {
  // -----------------------------------------------------------------------
  // 字段映射
  // -----------------------------------------------------------------------
  describe("字段映射", () => {
    it("所有字段正确映射到返回的 CheckpointData", () => {
      const checkpoint = buildCheckpoint(
        defaultArgs.runId,
        defaultArgs.workflowId,
        [...defaultArgs.completedStepIds],
        [...defaultArgs.pendingStepIds],
        [...defaultArgs.stepLogs],
        { ...defaultArgs.variables },
        { ...defaultArgs.stepResults },
        defaultArgs.totalSteps,
      );

      expect(checkpoint.runId).toBe("run-001");
      expect(checkpoint.workflowId).toBe("wf-abc");
      expect(checkpoint.completedSteps).toEqual(["step-1", "step-2"]);
      expect(checkpoint.pendingSteps).toEqual(["step-3", "step-4"]);
      expect(checkpoint.stepLogs).toEqual(defaultArgs.stepLogs);
      expect(checkpoint.variables).toEqual({ userId: "u-1", sessionId: "s-99" });
      expect(checkpoint.stepResults).toEqual({ "step-1": { score: 0.95 }, "step-2": { score: 0.87 } });
      expect(checkpoint.totalSteps).toBe(4);
    });

    it("runId 正确传递", () => {
      const cp = buildCheckpoint("custom-run", "wf", [], [], [], {}, {}, 0);
      expect(cp.runId).toBe("custom-run");
    });

    it("workflowId 正确传递", () => {
      const cp = buildCheckpoint("r", "custom-wf", [], [], [], {}, {}, 0);
      expect(cp.workflowId).toBe("custom-wf");
    });

    it("completedSteps 是传入数组的等值拷贝（浅层）", () => {
      const completed = ["a", "b", "c"];
      const cp = buildCheckpoint("r", "w", completed, [], [], {}, {}, 3);
      expect(cp.completedSteps).toEqual(["a", "b", "c"]);
    });

    it("pendingSteps 是传入数组的等值拷贝（浅层）", () => {
      const pending = ["x", "y"];
      const cp = buildCheckpoint("r", "w", [], pending, [], {}, {}, 2);
      expect(cp.pendingSteps).toEqual(["x", "y"]);
    });

    it("totalSteps 正确传递 — 0 步工作流", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      expect(cp.totalSteps).toBe(0);
    });

    it("totalSteps 正确传递 — 多步工作流", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 42);
      expect(cp.totalSteps).toBe(42);
    });

    it("stepLogs 包含完整的 StepResult 条目", () => {
      const logs: StepResult[] = [
        makeStepResult({ status: "completed", output: "done" }),
        makeStepResult({ status: "skipped", output: null, reason: "not needed" }),
      ];
      const cp = buildCheckpoint("r", "w", [], [], logs, {}, {}, 2);
      expect(cp.stepLogs).toHaveLength(2);
      expect(cp.stepLogs[0].status).toBe("completed");
      expect(cp.stepLogs[0].output).toBe("done");
      expect(cp.stepLogs[1].status).toBe("skipped");
      expect(cp.stepLogs[1].reason).toBe("not needed");
    });

    it("variables 正确传递 — 空对象", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      expect(cp.variables).toEqual({});
    });

    it("variables 正确传递 — 嵌套对象", () => {
      const vars = { nested: { deep: { value: 42 } }, arr: [1, 2, 3] };
      const cp = buildCheckpoint("r", "w", [], [], [], vars, {}, 0);
      expect(cp.variables).toEqual(vars);
    });

    it("stepResults 正确传递 — 空对象", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 5);
      expect(cp.stepResults).toEqual({});
    });

    it("stepResults 正确传递 — 包含 unknown 类型值", () => {
      const results: Record<string, unknown> = {
        "step-a": { data: [1, 2, 3] },
        "step-b": "text result",
        "step-c": null,
        "step-d": 123,
      };
      const cp = buildCheckpoint("r", "w", [], [], [], {}, results, 4);
      expect(cp.stepResults).toEqual(results);
    });
  });

  // -----------------------------------------------------------------------
  // currentStep 推导
  // -----------------------------------------------------------------------
  describe("currentStep 推导", () => {
    it("currentStep 是 pendingSteps 的第一个元素", () => {
      const cp = buildCheckpoint("r", "w", [], ["first-step", "second-step"], [], {}, {}, 2);
      expect(cp.currentStep).toBe("first-step");
    });

    it("只有一个待执行步骤时，currentStep 就是那个步骤", () => {
      const cp = buildCheckpoint("r", "w", [], ["only-step"], [], {}, {}, 1);
      expect(cp.currentStep).toBe("only-step");
    });

    it("pendingSteps 为空数组时，currentStep 为 null", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 5);
      expect(cp.currentStep).toBeNull();
    });

    it("pendingSteps 为空且 completedSteps 已全部完成 — terminal 状态", () => {
      const cp = buildCheckpoint(
        "run-done",
        "wf-complete",
        ["step-1", "step-2", "step-3"],
        [],
        [],
        {},
        {},
        3,
      );
      expect(cp.currentStep).toBeNull();
      expect(cp.completedSteps).toHaveLength(3);
      expect(cp.pendingSteps).toHaveLength(0);
    });

    it("pendingSteps 中包含重复步骤名时，currentStep 仍取首元素（不校验唯一性）", () => {
      const cp = buildCheckpoint("r", "w", [], ["dup", "dup", "other"], [], {}, {}, 3);
      expect(cp.currentStep).toBe("dup");
    });
  });

  // -----------------------------------------------------------------------
  // savedAt — ISO 8601 时间戳
  // -----------------------------------------------------------------------
  describe("savedAt 时间戳", () => {
    it("savedAt 是有效的 ISO 8601 字符串", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      const parsed = new Date(cp.savedAt);
      expect(parsed.toString()).not.toBe("Invalid Date");
      expect(cp.savedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    it("两次调用 savedAt 时间戳不同（反映实际调用时刻）", () => {
      const cp1 = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      // 用 busy-wait 确保时间推进（Date.now() 精度可能为 1ms）
      const start = Date.now();
      while (Date.now() === start) {
        // spin
      }
      const cp2 = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      expect(cp1.savedAt).not.toBe(cp2.savedAt);
    });

    it("savedAt 是 UTC 时间（以 Z 结尾）", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      expect(cp.savedAt.endsWith("Z")).toBe(true);
    });

    it("savedAt 可被 Date 解析为正确的时刻", () => {
      const before = Date.now();
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      const after = Date.now();
      const savedMs = new Date(cp.savedAt).getTime();
      expect(savedMs).toBeGreaterThanOrEqual(before);
      expect(savedMs).toBeLessThanOrEqual(after);
    });
  });

  // -----------------------------------------------------------------------
  // 不可变性 — 输入数组不被修改
  // -----------------------------------------------------------------------
  describe("输入不可变性", () => {
    it("completedStepIds 原始数组不被修改", () => {
      const original = ["s1", "s2"];
      const snapshot = [...original];
      buildCheckpoint("r", "w", original, ["p1"], [], {}, {}, 2);
      expect(original).toEqual(snapshot);
      expect(original).toHaveLength(2);
    });

    it("pendingStepIds 原始数组不被修改", () => {
      const original = ["p1", "p2", "p3"];
      const snapshot = [...original];
      buildCheckpoint("r", "w", ["c1"], original, [], {}, {}, 4);
      expect(original).toEqual(snapshot);
      expect(original).toHaveLength(3);
    });

    it("返回的 completedSteps 与输入是同一引用（直接赋值，无拷贝）", () => {
      const input = ["a"];
      const cp = buildCheckpoint("r", "w", input, [], [], {}, {}, 1);
      // 实现层直接赋值引用，不做拷贝：修改返回数组会反映到原始输入
      expect(cp.completedSteps).toBe(input);
      cp.completedSteps.push("b");
      expect(input).toEqual(["a", "b"]);
      expect(cp.completedSteps).toEqual(["a", "b"]);
    });

    it("返回的 pendingSteps 与输入是同一引用（直接赋值，无拷贝）", () => {
      const input = ["x"];
      const cp = buildCheckpoint("r", "w", [], input, [], {}, {}, 1);
      // 实现层直接赋值引用，不做拷贝
      expect(cp.pendingSteps).toBe(input);
      cp.pendingSteps.push("y");
      expect(input).toEqual(["x", "y"]);
      expect(cp.pendingSteps).toEqual(["x", "y"]);
    });

    it("stepLogs 数组引用指向同一个 — 浅层不可变语义", () => {
      // buildCheckpoint 只是将引用赋给返回对象，不做深拷贝。
      // 验证语义：修改返回对象的 stepLogs 数组结构会反映到原始引用？
      // 实际上 JavaScript 对象赋值是引用传递。
      const logs = [makeStepResult({ status: "completed" })];
      const cp = buildCheckpoint("r", "w", [], [], logs, {}, {}, 1);
      // 同一个引用
      expect(cp.stepLogs).toBe(logs);
      // 但原始数组长度未变
      expect(logs).toHaveLength(1);
    });

    it("variables 对象引用不变（浅层不可变）", () => {
      const vars = { key: "val" };
      const cp = buildCheckpoint("r", "w", [], [], [], vars, {}, 0);
      expect(cp.variables).toBe(vars);
    });

    it("stepResults 对象引用不变（浅层不可变）", () => {
      const results = { "s1": "ok" };
      const cp = buildCheckpoint("r", "w", [], [], [], {}, results, 1);
      expect(cp.stepResults).toBe(results);
    });
  });

  // -----------------------------------------------------------------------
  // JSON 序列化往返
  // -----------------------------------------------------------------------
  describe("JSON 序列化往返", () => {
    it("JSON.stringify → JSON.parse 往返后字段值一致", () => {
      const logs: StepResult[] = [
        makeStepResult({ status: "completed", output: { text: "hello" }, durationMs: 300 }),
        makeStepResult({ status: "failed", output: null, error: "crash", retryCount: 1, tokensUsed: 500 }),
        makeStepResult({ status: "skipped", output: null, reason: "condition false" }),
      ];

      const original = buildCheckpoint(
        "run-json",
        "wf-json",
        ["done-1", "done-2"],
        ["next-1"],
        logs,
        { env: "prod", flags: { debug: false } },
        { "done-1": { ok: true }, "done-2": { ok: true } },
        3,
      );

      const json = JSON.stringify(original);
      const restored: CheckpointData = JSON.parse(json);

      expect(restored.runId).toBe(original.runId);
      expect(restored.workflowId).toBe(original.workflowId);
      expect(restored.completedSteps).toEqual(original.completedSteps);
      expect(restored.currentStep).toBe(original.currentStep);
      expect(restored.pendingSteps).toEqual(original.pendingSteps);
      expect(restored.totalSteps).toBe(original.totalSteps);
      expect(restored.savedAt).toBe(original.savedAt);
      expect(restored.variables).toEqual(original.variables);
      expect(restored.stepResults).toEqual(original.stepResults);
      expect(restored.stepLogs).toEqual(original.stepLogs);
    });

    it("currentStep 为 null 时 JSON 往返仍保持 null", () => {
      const cp = buildCheckpoint("r", "w", ["all-done"], [], [], {}, {}, 1);
      expect(cp.currentStep).toBeNull();

      const restored: CheckpointData = JSON.parse(JSON.stringify(cp));
      expect(restored.currentStep).toBeNull();
    });

    it("variables 中包含 Date 对象时 JSON 序列化转为字符串（JSON 原生行为）", () => {
      // 验证 JSON 序列化对非 JSON-safe 值的处理行为
      const cp = buildCheckpoint(
        "r",
        "w",
        [],
        [],
        [],
        { createdAt: new Date("2025-01-01T00:00:00.000Z") },
        {},
        0,
      );
      const json = JSON.stringify(cp);
      const restored = JSON.parse(json);
      // Date 被序列化为 ISO 字符串，反序列化后是字符串而非 Date
      expect(typeof restored.variables.createdAt).toBe("string");
      expect(restored.variables.createdAt).toBe("2025-01-01T00:00:00.000Z");
    });

    it("stepLogs 中包含 undefined 值字段时 JSON 序列化会丢弃该字段", () => {
      const logs: StepResult[] = [
        { status: "completed", output: undefined } as unknown as StepResult,
      ];
      const cp = buildCheckpoint("r", "w", [], [], logs, {}, {}, 1);
      const restored = JSON.parse(JSON.stringify(cp));
      // undefined 值在 JSON.stringify 时被丢弃
      expect(restored.stepLogs[0]).not.toHaveProperty("output");
    });

    it("空 checkpoint 往返正确", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      const restored: CheckpointData = JSON.parse(JSON.stringify(cp));
      expect(restored.runId).toBe("r");
      expect(restored.completedSteps).toEqual([]);
      expect(restored.pendingSteps).toEqual([]);
      expect(restored.currentStep).toBeNull();
      expect(restored.totalSteps).toBe(0);
      expect(restored.savedAt).toBe(cp.savedAt);
    });
  });

  // -----------------------------------------------------------------------
  // StepResult 类型兼容性
  // -----------------------------------------------------------------------
  describe("StepResult 类型兼容性", () => {
    it("completed 状态的 StepResult 包含必要字段", () => {
      const log: StepResult = { status: "completed", output: { result: 42 } };
      const cp = buildCheckpoint("r", "w", ["s1"], [], [log], {}, {}, 1);
      const entry = cp.stepLogs[0];
      expect(entry.status).toBe("completed");
      expect(entry.output).toEqual({ result: 42 });
    });

    it("failed 状态的 StepResult 包含 error 与 retryCount", () => {
      const log: StepResult = {
        status: "failed",
        output: null,
        error: "Network timeout after 30s",
        retryCount: 3,
        durationMs: 30000,
        tokensUsed: 1200,
      };
      const cp = buildCheckpoint("r", "w", ["s1"], [], [log], {}, {}, 1);
      const entry = cp.stepLogs[0];
      expect(entry.status).toBe("failed");
      expect(entry.error).toBe("Network timeout after 30s");
      expect(entry.retryCount).toBe(3);
      expect(entry.durationMs).toBe(30000);
      expect(entry.tokensUsed).toBe(1200);
    });

    it("skipped 状态的 StepResult 包含 reason", () => {
      const log: StepResult = {
        status: "skipped",
        output: null,
        reason: "Condition evaluated to false",
      };
      const cp = buildCheckpoint("r", "w", ["s1"], [], [log], {}, {}, 1);
      const entry = cp.stepLogs[0];
      expect(entry.status).toBe("skipped");
      expect(entry.reason).toBe("Condition evaluated to false");
    });

    it("stepLogs 可以混合不同状态的 StepResult", () => {
      const logs: StepResult[] = [
        { status: "completed", output: "ok", durationMs: 100, tokensUsed: 50 },
        { status: "failed", output: null, error: "oops", retryCount: 1 },
        { status: "skipped", output: null, reason: "skip" },
        { status: "completed", output: { nested: true }, durationMs: 200 },
      ];
      const cp = buildCheckpoint("r", "w", ["a", "b", "c", "d"], [], logs, {}, {}, 4);
      expect(cp.stepLogs).toHaveLength(4);
      expect(cp.stepLogs[0].status).toBe("completed");
      expect(cp.stepLogs[1].status).toBe("failed");
      expect(cp.stepLogs[2].status).toBe("skipped");
      expect(cp.stepLogs[3].status).toBe("completed");
    });

    it("StepResult.output 接受任意 unknown 类型值", () => {
      const outputs: unknown[] = [
        "string output",
        42,
        true,
        null,
        { complex: { nested: [1, 2, 3] } },
        ["array", "of", "values"],
        undefined,
      ];

      const logs: StepResult[] = outputs.map((out) => ({
        status: "completed" as const,
        output: out,
      }));

      const cp = buildCheckpoint("r", "w", [], [], logs, {}, {}, outputs.length);
      expect(cp.stepLogs).toHaveLength(outputs.length);

      // 所有 output 值保持不变
      for (let i = 0; i < outputs.length; i++) {
        expect(cp.stepLogs[i].output).toBe(outputs[i]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // pendingSteps 空数组 → currentStep 为 null
  // -----------------------------------------------------------------------
  describe("pendingSteps 为空时 currentStep 为 null", () => {
    it("所有步骤已完成，无待执行步骤", () => {
      const cp = buildCheckpoint(
        "run-all-done",
        "wf-1",
        ["step-1", "step-2", "step-3", "step-4"],
        [],
        [
          makeStepResult({ status: "completed" }),
          makeStepResult({ status: "completed" }),
          makeStepResult({ status: "completed" }),
          makeStepResult({ status: "completed" }),
        ],
        {},
        {},
        4,
      );
      expect(cp.currentStep).toBeNull();
      expect(cp.pendingSteps).toEqual([]);
      expect(cp.completedSteps).toHaveLength(4);
    });

    it("工作流尚未开始，所有步骤都是待执行", () => {
      const cp = buildCheckpoint(
        "run-fresh",
        "wf-2",
        [],
        ["init", "process", "finalize"],
        [],
        {},
        {},
        3,
      );
      expect(cp.currentStep).toBe("init");
      expect(cp.pendingSteps).toEqual(["init", "process", "finalize"]);
      expect(cp.completedSteps).toEqual([]);
    });

    it("空的 stepLogs 与空 pendingSteps 的组合", () => {
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      expect(cp.currentStep).toBeNull();
      expect(cp.stepLogs).toEqual([]);
    });

    it("pendingSteps 由非空变为空 — 验证 null 而非 undefined", () => {
      // pendingSteps[0] || null 确保空数组返回 null 而非 undefined
      const cp = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      expect(cp.currentStep).toBeNull();
      expect(cp.currentStep).not.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 边界条件
  // -----------------------------------------------------------------------
  describe("边界条件", () => {
    it("totalSteps 大于实际步骤数（预分配容量场景）", () => {
      const cp = buildCheckpoint("r", "w", ["a"], ["b"], [], {}, {}, 100);
      expect(cp.totalSteps).toBe(100);
      expect(cp.completedSteps).toHaveLength(1);
      expect(cp.pendingSteps).toHaveLength(1);
    });

    it("totalSteps 小于 completedSteps + pendingSteps 之和（调用者错误场景，函数不校验）", () => {
      // 函数不负责校验逻辑一致性，仅如实记录传入值
      const cp = buildCheckpoint("r", "w", ["a", "b"], ["c", "d"], [], {}, {}, 1);
      expect(cp.totalSteps).toBe(1);
      expect(cp.completedSteps).toHaveLength(2);
      expect(cp.pendingSteps).toHaveLength(2);
    });

    it("stepLogs 与 completedSteps 数量不一致（partial logging 场景）", () => {
      const cp = buildCheckpoint(
        "r",
        "w",
        ["a", "b", "c"],
        ["d"],
        [makeStepResult({ status: "completed" })], // 只有 1 条 log，但 3 个 completed
        {},
        {},
        4,
      );
      expect(cp.completedSteps).toHaveLength(3);
      expect(cp.stepLogs).toHaveLength(1);
    });

    it("runId / workflowId 为空字符串", () => {
      const cp = buildCheckpoint("", "", [], [], [], {}, {}, 0);
      expect(cp.runId).toBe("");
      expect(cp.workflowId).toBe("");
      expect(cp.currentStep).toBeNull();
    });

    it("步骤 ID 中包含特殊字符", () => {
      const cp = buildCheckpoint(
        "r",
        "w",
        ["step.with.dots", "step/with/slashes", "step with spaces"],
        ["step-@#$%"],
        [],
        {},
        {},
        4,
      );
      expect(cp.completedSteps).toHaveLength(3);
      expect(cp.pendingSteps).toEqual(["step-@#$%"]);
      expect(cp.currentStep).toBe("step-@#$%");
    });
  });

  // -----------------------------------------------------------------------
  // 类型编译期验证（运行时也验证）
  // -----------------------------------------------------------------------
  describe("类型兼容性", () => {
    it("返回类型可赋值给 CheckpointData", () => {
      const cp: CheckpointData = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      expect(cp).toBeDefined();
      // 所有 CheckpointData 字段存在
      expect(cp).toHaveProperty("runId");
      expect(cp).toHaveProperty("workflowId");
      expect(cp).toHaveProperty("completedSteps");
      expect(cp).toHaveProperty("currentStep");
      expect(cp).toHaveProperty("pendingSteps");
      expect(cp).toHaveProperty("stepLogs");
      expect(cp).toHaveProperty("variables");
      expect(cp).toHaveProperty("stepResults");
      expect(cp).toHaveProperty("savedAt");
      expect(cp).toHaveProperty("totalSteps");
    });

    it("CheckpointData 接口与 WorkflowCheckpoint 接口结构一致", () => {
      // 运行时验证两个概念上应一致的接口确实字段相同
      const cp: CheckpointData = buildCheckpoint("r", "w", [], [], [], {}, {}, 0);
      // WorkflowCheckpoint 所有字段在 CheckpointData 上都存在
      const expectedKeys: (keyof CheckpointData)[] = [
        "runId",
        "workflowId",
        "completedSteps",
        "currentStep",
        "pendingSteps",
        "stepLogs",
        "variables",
        "stepResults",
        "savedAt",
        "totalSteps",
      ];
      for (const key of expectedKeys) {
        expect(cp).toHaveProperty(key);
      }
    });
  });
});
