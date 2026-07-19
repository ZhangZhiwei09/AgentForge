// ExecutionScope 工厂测试
//
// 验证 createExecutionScope() 的所有契约：
// - 返回结构完整性（context / node / buffer / trace / controller）
// - context 不可变性（Object.freeze）
// - node 状态正确性（初始 CREATED，shouldStop 响应 signal）
// - buffer 初始状态
// - trace 注入与默认值
// - 独立性与隔离性
// - parentContext 子 Context 创建
// - 自定义 runId / executionType

import { describe, it, expect, beforeEach } from "vitest";
import { createExecutionScope, type ExecutionScope } from "../scope.js";
import { ExecutionNode } from "../controller.js";
import { OutputBuffer } from "../buffer.js";
import { ExecutionState } from "../results.js";
import { NoopTrace, type ObservabilityTrace } from "../../observability/provider.js";

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function createSignal(): AbortSignal {
  return new AbortController().signal;
}

function createMinimalScope(overrides: Partial<{
  signal: AbortSignal;
  runId: string;
  executionType: Parameters<typeof createExecutionScope>[0]["executionType"];
  trace: ObservabilityTrace;
}> = {}): ExecutionScope {
  return createExecutionScope({
    signal: overrides.signal ?? createSignal(),
    runId: overrides.runId,
    executionType: overrides.executionType,
    trace: overrides.trace,
  });
}

// ═══════════════════════════════════════════════════════
// 结构完整性
// ═══════════════════════════════════════════════════════

describe("createExecutionScope", () => {
  let scope: ExecutionScope;

  beforeEach(() => {
    scope = createMinimalScope();
  });

  // ── Test 1: 返回结构完整性 ──

  describe("returns object with context, node, buffer, trace fields", () => {
    it("has context field", () => {
      expect(scope).toHaveProperty("context");
      expect(scope.context).toBeDefined();
    });

    it("has node field", () => {
      expect(scope).toHaveProperty("node");
      expect(scope.node).toBeDefined();
      expect(scope.node).toBeInstanceOf(ExecutionNode);
    });

    it("has buffer field", () => {
      expect(scope).toHaveProperty("buffer");
      expect(scope.buffer).toBeDefined();
      expect(scope.buffer).toBeInstanceOf(OutputBuffer);
    });

    it("has trace field", () => {
      expect(scope).toHaveProperty("trace");
    });

    it("has controller field (deprecated, equals node)", () => {
      expect(scope).toHaveProperty("controller");
      expect(scope.controller).toBe(scope.node);
    });
  });

  // ── Test 2: context field is a valid RunContext (frozen, has runId) ──

  describe("context field is a valid RunContext", () => {
    it("is frozen (immutable)", () => {
      expect(Object.isFrozen(scope.context)).toBe(true);
    });

    it("has a non-empty string runId", () => {
      expect(scope.context.runId).toEqual(expect.any(String));
      expect(scope.context.runId.length).toBeGreaterThan(0);
    });

    it("has a UUID v4 format runId by default", () => {
      // UUID v4 regex
      const uuidV4Regex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(scope.context.runId).toMatch(uuidV4Regex);
    });

    it("has an AbortSignal", () => {
      expect(scope.context.signal).toBeInstanceOf(AbortSignal);
    });

    it("has ancestry containing runId as root", () => {
      expect(scope.context.ancestry).toEqual([scope.context.runId]);
    });

    it("throws when attempting to mutate frozen context", () => {
      // Object.freeze in strict mode throws TypeError on assignment
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (scope.context as any).runId = "modified";
      }).toThrow(TypeError);
    });
  });

  // ── Test 3: node field is ExecutionNode in CREATED state ──

  describe("node field is an ExecutionNode in CREATED state", () => {
    it("has state CREATED initially", () => {
      expect(scope.node.state).toBe(ExecutionState.CREATED);
    });

    it("isTerminal is false (CREATED is non-terminal)", () => {
      expect(scope.node.isTerminal).toBe(false);
    });

    it("has id equal to context.runId", () => {
      expect(scope.node.id).toBe(scope.context.runId);
    });

    it("has default type 'chat'", () => {
      expect(scope.node.type).toBe("chat");
    });

    it("has no parent (null)", () => {
      expect(scope.node.parent).toBeNull();
    });

    it("has no children initially", () => {
      expect(scope.node.children).toEqual([]);
    });

    it("duration is 0 (not started)", () => {
      expect(scope.node.duration).toBe(0);
    });

    it("shouldStop is false (signal not aborted, not cancelled)", () => {
      expect(scope.node.shouldStop).toBe(false);
    });
  });

  // ── Test 4: buffer field is an OutputBuffer (isEmpty=true initially) ──

  describe("buffer field is an OutputBuffer", () => {
    it("isEmpty returns true initially", () => {
      expect(scope.buffer.isEmpty).toBe(true);
    });

    it("getContent returns empty string initially", () => {
      expect(scope.buffer.getContent()).toBe("");
    });

    it("can append content", () => {
      scope.buffer.append("hello");
      expect(scope.buffer.isEmpty).toBe(false);
      expect(scope.buffer.getContent()).toBe("hello");
    });

    it("can clear content", () => {
      scope.buffer.append("temp data");
      scope.buffer.clear();
      expect(scope.buffer.isEmpty).toBe(true);
      expect(scope.buffer.getContent()).toBe("");
    });
  });

  // ── Test 5: trace field is undefined when no ObservabilityTrace provided ──

  describe("trace field default", () => {
    it("is undefined when no trace option provided", () => {
      expect(scope.trace).toBeUndefined();
    });
  });

  // ── Test 6: trace field is set when ObservabilityTrace provided ──

  describe("trace field when ObservabilityTrace provided", () => {
    it("holds the provided trace instance", () => {
      const trace = new NoopTrace();
      const scoped = createMinimalScope({ trace });
      expect(scoped.trace).toBe(trace);
    });

    it("holds a different trace instance for different scopes", () => {
      const trace1 = new NoopTrace();
      const trace2 = new NoopTrace();
      const scope1 = createMinimalScope({ trace: trace1 });
      const scope2 = createMinimalScope({ trace: trace2 });
      expect(scope1.trace).toBe(trace1);
      expect(scope2.trace).toBe(trace2);
      expect(scope1.trace).not.toBe(scope2.trace);
    });
  });

  // ── Test 7: 独立性 — 每个 createExecutionScope() 调用创建独立 scope ──

  describe("each call creates independent scope", () => {
    it("different runIds", () => {
      const scope1 = createMinimalScope();
      const scope2 = createMinimalScope();
      expect(scope1.context.runId).not.toBe(scope2.context.runId);
    });

    it("different node identities", () => {
      const scope1 = createMinimalScope();
      const scope2 = createMinimalScope();
      expect(scope1.node).not.toBe(scope2.node);
      expect(scope1.node.id).not.toBe(scope2.node.id);
    });

    it("different buffer identities", () => {
      const scope1 = createMinimalScope();
      const scope2 = createMinimalScope();
      expect(scope1.buffer).not.toBe(scope2.buffer);
    });

    it("buffer mutation is isolated", () => {
      const scope1 = createMinimalScope();
      const scope2 = createMinimalScope();
      scope1.buffer.append("scope1 data");
      expect(scope1.buffer.getContent()).toBe("scope1 data");
      expect(scope2.buffer.getContent()).toBe("");
      expect(scope2.buffer.isEmpty).toBe(true);
    });

    it("different AbortSignals when using separate controllers", () => {
      const ctrl1 = new AbortController();
      const ctrl2 = new AbortController();
      const scope1 = createMinimalScope({ signal: ctrl1.signal });
      const scope2 = createMinimalScope({ signal: ctrl2.signal });

      ctrl1.abort();
      expect(scope1.node.shouldStop).toBe(true);
      expect(scope2.node.shouldStop).toBe(false);
    });
  });

  // ── Test 8: scope.controller.shouldStop reflects signal.aborted ──

  describe("controller.shouldStop reflects signal.aborted after abort", () => {
    it("shouldStop is false before abort", () => {
      const ctrl = new AbortController();
      const scoped = createMinimalScope({ signal: ctrl.signal });
      expect(scoped.controller.shouldStop).toBe(false);
    });

    it("shouldStop is true after abort", () => {
      const ctrl = new AbortController();
      const scoped = createMinimalScope({ signal: ctrl.signal });
      ctrl.abort();
      expect(scoped.controller.shouldStop).toBe(true);
    });

    it("shouldStop is true immediately after abort (sync)", () => {
      const ctrl = new AbortController();
      const scoped = createMinimalScope({ signal: ctrl.signal });

      expect(scoped.controller.shouldStop).toBe(false);
      ctrl.abort("test reason");
      expect(scoped.context.signal.aborted).toBe(true);
      expect(scoped.controller.shouldStop).toBe(true);
    });

    it("controller and node refer to the same object", () => {
      const scope = createMinimalScope();
      expect(scope.controller).toBe(scope.node);
    });
  });
});

// ═══════════════════════════════════════════════════════
// 高级场景
// ═══════════════════════════════════════════════════════

describe("createExecutionScope — advanced scenarios", () => {
  // ── 自定义 runId ──

  describe("custom runId", () => {
    it("context.runId equals the provided runId", () => {
      const scope = createMinimalScope({ runId: "test-run-001" });
      expect(scope.context.runId).toBe("test-run-001");
    });

    it("node.id equals the provided runId", () => {
      const scope = createMinimalScope({ runId: "test-run-002" });
      expect(scope.node.id).toBe("test-run-002");
    });

    it("ancestry contains the custom runId", () => {
      const scope = createMinimalScope({ runId: "custom-id" });
      expect(scope.context.ancestry).toEqual(["custom-id"]);
    });
  });

  // ── 自定义 executionType ──

  describe("custom executionType", () => {
    it("node.type reflects the provided executionType", () => {
      const types = ["chat", "agent", "tool", "workflow", "voice", "subagent"] as const;
      for (const t of types) {
        const scope = createMinimalScope({ executionType: t });
        expect(scope.node.type).toBe(t);
      }
    });
  });

  // ── parentContext 创建子 Context ──

  describe("parentContext (child context)", () => {
    it("creates a child context with different runId", () => {
      const parentScope = createMinimalScope({ runId: "parent-run" });
      const childScope = createExecutionScope({
        signal: createSignal(),
        parentContext: parentScope.context,
      });

      expect(childScope.context.runId).not.toBe(parentScope.context.runId);
    });

    it("child ancestry includes parent ancestry + child runId", () => {
      const parentScope = createMinimalScope({ runId: "parent-run" });
      const childScope = createExecutionScope({
        signal: createSignal(),
        parentContext: parentScope.context,
      });

      expect(childScope.context.ancestry).toEqual([
        "parent-run",
        childScope.context.runId,
      ]);
    });

    it("child shares parent's AbortSignal", () => {
      const ctrl = new AbortController();
      const parentScope = createMinimalScope({ signal: ctrl.signal });
      const childScope = createExecutionScope({
        signal: createSignal(), // signal参数在子Context场景不会被使用
        parentContext: parentScope.context,
      });

      // child 继承 parent 的 signal
      expect(childScope.context.signal).toBe(parentScope.context.signal);

      ctrl.abort();
      expect(childScope.node.shouldStop).toBe(true);
      expect(parentScope.node.shouldStop).toBe(true);
    });

    it("multi-level ancestry", () => {
      const root = createMinimalScope({ runId: "root" });
      const child = createExecutionScope({
        signal: createSignal(),
        parentContext: root.context,
      });
      const grandchild = createExecutionScope({
        signal: createSignal(),
        parentContext: child.context,
      });

      expect(grandchild.context.ancestry).toEqual([
        "root",
        child.context.runId,
        grandchild.context.runId,
      ]);
    });
  });

  // ── signal 未 abort 场景 ──

  describe("signal edge cases", () => {
    it("already-aborted signal is reflected immediately", () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const scope = createMinimalScope({ signal: ctrl.signal });
      expect(scope.node.shouldStop).toBe(true);
    });

    it("aborted reason is accessible via signal.reason", () => {
      const ctrl = new AbortController();
      const reason = new DOMException("test abort", "AbortError");
      ctrl.abort(reason);
      const scope = createMinimalScope({ signal: ctrl.signal });
      expect(scope.context.signal.reason).toBe(reason);
    });
  });
});
