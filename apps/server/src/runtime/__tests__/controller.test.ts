// ExecutionNode State Machine Tests
// ============================================
// 验证 ExecutionNode 的完整状态机行为：
// - 合法/非法状态转移
// - 树结构与父子关系
// - 级联取消
// - shouldStop 断言
// - 监听器机制
//
// 设计文档：controller.ts 头注释
// 冻结日期：2026-07-16
//
// 注意：createChild() 在 controller.ts 中使用动态 require('./context.js')，
// 在 ESM 模式下会失败。本测试文件绕过 createChild() 方法，
// 直接使用导入的 createChildContext + new ExecutionNode 构造子节点，
// 以覆盖树结构和级联行为。这暴露了 controller.ts 中的一个已知问题：
// createChild() 的 require() 调用在 ESM 项目中不可用。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExecutionNode, RunTermination } from "../controller.js";
import type { ExecutionType } from "../controller.js";
import { ExecutionState } from "../results.js";
import { createRunContext, createChildContext } from "../context.js";
import { OutputBuffer } from "../buffer.js";

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function createRootNode(
  type: ExecutionType = "agent",
  signal?: AbortSignal,
): ExecutionNode {
  const ctx = createRunContext(signal ?? new AbortController().signal);
  return new ExecutionNode(type, ctx);
}

/**
 * Manually create a child ExecutionNode using the imported createChildContext.
 * This bypasses controller.ts's createChild() method which uses require() internally,
 * avoiding the ESM compatibility issue.
 */
function createChildNode(
  parent: ExecutionNode,
  type: ExecutionType = "tool",
  childRunId?: string,
): ExecutionNode {
  const childContext = createChildContext(parent.context, childRunId);
  return new ExecutionNode(type, childContext, undefined, parent);
}

// ═══════════════════════════════════════════════════════
// STATE TRANSITIONS
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — State Transitions", () => {
  let node: ExecutionNode;

  beforeEach(() => {
    node = createRootNode("agent");
  });

  // ── Valid Transitions ──

  describe("Valid Transitions", () => {
    it("CREATED → RUNNING → COMPLETED", () => {
      expect(node.state).toBe(ExecutionState.CREATED);

      node.start();
      expect(node.state).toBe(ExecutionState.RUNNING);

      const result = node.complete();
      expect(node.state).toBe(ExecutionState.COMPLETED);
      expect(result.termination).toBe(RunTermination.Completed);
      expect(result.error).toBeUndefined();
    });

    it("CREATED → RUNNING → FAILED", () => {
      node.start();
      expect(node.state).toBe(ExecutionState.RUNNING);

      const result = node.fail("LLM timeout after 30s");
      expect(node.state).toBe(ExecutionState.FAILED);
      expect(result.termination).toBe(RunTermination.Failed);
      expect(result.error).toBe("LLM timeout after 30s");
    });

    it("CREATED → RUNNING → CANCELLED", () => {
      node.start();
      expect(node.state).toBe(ExecutionState.RUNNING);

      const result = node.cancel("user requested");
      expect(node.state).toBe(ExecutionState.CANCELLED);
      expect(result.termination).toBe(RunTermination.Cancelled);
      expect(result.error).toBeUndefined();
    });

    it("CREATED → RUNNING → TIMEOUT", () => {
      node.start();
      expect(node.state).toBe(ExecutionState.RUNNING);

      const result = node.timeout(30000);
      expect(node.state).toBe(ExecutionState.TIMEOUT);
      expect(result.termination).toBe(RunTermination.Timeout);
      expect(result.error).toBe("Timed out after 30000ms");
    });
  });

  // ── Invalid Transitions ──

  describe("Invalid Transitions — Skip RUNNING", () => {
    it("CREATED → COMPLETED should throw", () => {
      expect(() => node.complete()).toThrow(
        "[ExecutionNode] Invalid state transition: created → completed",
      );
    });

    it("CREATED → FAILED should throw", () => {
      expect(() => node.fail("oops")).toThrow(
        "[ExecutionNode] Invalid state transition: created → failed",
      );
    });

    it("CREATED → CANCELLED should throw", () => {
      expect(() => node.cancel("oops")).toThrow(
        "[ExecutionNode] Invalid state transition: created → cancelled",
      );
    });

    it("CREATED → TIMEOUT should throw", () => {
      expect(() => node.timeout(5000)).toThrow(
        "[ExecutionNode] Invalid state transition: created → timeout",
      );
    });
  });

  describe("Invalid Transitions — Terminal States (Irreversible)", () => {
    /**
     * 验证从终端态出发的所有非法转移。
     * cancel() 在 CANCELLED 状态下是幂等的（设计如此），因此对其单独验证。
     * 其他所有转移（start, complete, fail, timeout）均必须抛出。
     */
    function driveToTerminal(
      n: ExecutionNode,
      target: ExecutionState,
    ): void {
      n.start();
      switch (target) {
        case ExecutionState.COMPLETED:
          n.complete();
          break;
        case ExecutionState.FAILED:
          n.fail("err");
          break;
        case ExecutionState.CANCELLED:
          n.cancel("reason");
          break;
        case ExecutionState.TIMEOUT:
          n.timeout(1000);
          break;
      }
    }

    function assertIrreversibleExceptCancel(target: ExecutionState): void {
      const n = createRootNode("agent");
      driveToTerminal(n, target);
      expect(n.state).toBe(target);

      // All non-idempotent transitions must throw
      expect(() => n.start()).toThrow("Invalid state transition");
      expect(() => n.complete()).toThrow("Invalid state transition");
      expect(() => n.fail("err")).toThrow("Invalid state transition");
      expect(() => n.timeout(1000)).toThrow("Invalid state transition");

      // cancel() is idempotent on CANCELLED but not on other terminal states
      if (target === ExecutionState.CANCELLED) {
        // Should NOT throw — idempotent by design
        const result = n.cancel("again");
        expect(result.termination).toBe(RunTermination.Cancelled);
        expect(n.state).toBe(ExecutionState.CANCELLED);
      } else {
        expect(() => n.cancel("reason")).toThrow("Invalid state transition");
      }
    }

    it("COMPLETED → any other state should throw", () => {
      assertIrreversibleExceptCancel(ExecutionState.COMPLETED);
    });

    it("FAILED → any other state should throw", () => {
      assertIrreversibleExceptCancel(ExecutionState.FAILED);
    });

    it("CANCELLED → any other state should throw (cancel is idempotent)", () => {
      assertIrreversibleExceptCancel(ExecutionState.CANCELLED);
    });

    it("TIMEOUT → any other state should throw", () => {
      assertIrreversibleExceptCancel(ExecutionState.TIMEOUT);
    });
  });

  // ── Idempotency ──

  describe("Idempotent Operations", () => {
    it("start() on RUNNING is idempotent", () => {
      node.start();
      expect(node.state).toBe(ExecutionState.RUNNING);
      // Second start should not throw and state should remain RUNNING
      node.start();
      expect(node.state).toBe(ExecutionState.RUNNING);
    });

    it("cancel() on CANCELLED is idempotent", () => {
      node.start();
      node.cancel("first");
      expect(node.state).toBe(ExecutionState.CANCELLED);
      // Second cancel on already CANCELLED should return immediately
      const result = node.cancel("second");
      expect(node.state).toBe(ExecutionState.CANCELLED);
      expect(result.termination).toBe(RunTermination.Cancelled);
    });
  });
});

// ═══════════════════════════════════════════════════════
// TREE STRUCTURE
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — Tree Structure", () => {
  describe("Parent / Child Registration", () => {
    it("child is registered on parent.children", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      expect(root.children).toHaveLength(1);
      expect(root.children[0]).toBe(child);
      expect(child.parent).toBe(root);
    });

    it("child.type and child.id are independent from parent", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      expect(child.type).toBe("tool");
      expect(child.id).not.toBe(root.id);
    });

    it("child inherits parent.signal", () => {
      const controller = new AbortController();
      const root = createRootNode("agent", controller.signal);
      const child = createChildNode(root, "tool");

      // Children share the same signal reference
      expect(child.context.signal).toBe(root.context.signal);
    });

    it("child ancestry extends parent ancestry", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      expect(root.context.ancestry).toHaveLength(1);
      expect(child.context.ancestry).toHaveLength(2);
      expect(child.context.ancestry[0]).toBe(root.context.ancestry[0]);
      // Last entry is child's own id
      expect(child.context.ancestry[1]).toBe(child.id);
    });
  });

  describe("Multi-Level Tree (3+ levels)", () => {
    it("grandchild is registered under child and has correct ancestry", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");
      const grandchild = createChildNode(child, "subagent");

      // Tree structure
      expect(root.children).toHaveLength(1);
      expect(root.children[0]).toBe(child);
      expect(child.children).toHaveLength(1);
      expect(child.children[0]).toBe(grandchild);
      expect(grandchild.parent).toBe(child);

      // Ancestry depth
      expect(root.context.ancestry).toHaveLength(1);
      expect(child.context.ancestry).toHaveLength(2);
      expect(grandchild.context.ancestry).toHaveLength(3);
      expect(grandchild.context.ancestry[0]).toBe(root.id);
      expect(grandchild.context.ancestry[1]).toBe(child.id);
      expect(grandchild.context.ancestry[2]).toBe(grandchild.id);
    });

    it("4-level deep tree maintains correct structure", () => {
      const root = createRootNode("chat");
      const child = createChildNode(root, "agent");
      const grandchild = createChildNode(child, "tool");
      const greatGrandchild = createChildNode(grandchild, "tool");

      expect(root.children).toHaveLength(1);
      expect(child.children).toHaveLength(1);
      expect(grandchild.children).toHaveLength(1);
      expect(greatGrandchild.parent).toBe(grandchild);

      expect(greatGrandchild.context.ancestry).toHaveLength(4);
    });
  });

  describe("Child Context Independence", () => {
    it("sibling children have independent runIds", () => {
      const root = createRootNode("agent");
      const childA = createChildNode(root, "tool");
      const childB = createChildNode(root, "tool");

      expect(root.children).toHaveLength(2);
      expect(childA.id).not.toBe(childB.id);
      expect(childA.context.runId).toBe(childA.id);
      expect(childB.context.runId).toBe(childB.id);
    });

    it("sibling children share same signal reference but have distinct ancestry", () => {
      const root = createRootNode("agent");
      const childA = createChildNode(root, "tool");
      const childB = createChildNode(root, "tool");

      expect(childA.context.signal).toBe(childB.context.signal);
      expect(childA.context.signal).toBe(root.context.signal);

      // Each child appends its own id to the parent ancestry
      expect(childA.context.ancestry[1]).toBe(childA.id);
      expect(childB.context.ancestry[1]).toBe(childB.id);
    });
  });
});

// ═══════════════════════════════════════════════════════
// CASCADE
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — Cascade", () => {
  describe("cancel() on parent cancels non-terminal children", () => {
    it("all RUNNING children become CANCELLED", () => {
      const root = createRootNode("agent");
      const childA = createChildNode(root, "tool");
      const childB = createChildNode(root, "tool");

      root.start();
      childA.start();
      childB.start();

      root.cancel("user abort");

      expect(root.state).toBe(ExecutionState.CANCELLED);
      expect(childA.state).toBe(ExecutionState.CANCELLED);
      expect(childB.state).toBe(ExecutionState.CANCELLED);
    });

    it("CREATED children (never started) — cancelActiveChildren throws due to CREATED → CANCELLED gap", () => {
      // Known gap: VALID_TRANSITIONS only allows CREATED → RUNNING.
      // cancelActiveChildren calls child.cancel() on non-terminal children,
      // but CREATED is non-terminal yet has no valid path to CANCELLED.
      // This test documents the current behavior — the throw bubbles up.
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      root.start();
      // child is still CREATED (never started)

      expect(() => root.cancel("parent cancelled")).toThrow(
        "[ExecutionNode] Invalid state transition: created → cancelled",
      );

      // child is still CREATED (cascade was rejected)
      expect(child.state).toBe(ExecutionState.CREATED);
      // root did not reach CANCELLED because the cascade threw
    });
  });

  describe("cancel() on parent preserves terminal children", () => {
    it("already COMPLETED child stays COMPLETED", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      root.start();
      child.start();
      child.complete();
      expect(child.state).toBe(ExecutionState.COMPLETED);

      root.cancel("parent cancelled");
      expect(root.state).toBe(ExecutionState.CANCELLED);
      expect(child.state).toBe(ExecutionState.COMPLETED); // unchanged
    });

    it("already FAILED child stays FAILED", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      root.start();
      child.start();
      child.fail("tool error");
      expect(child.state).toBe(ExecutionState.FAILED);

      root.cancel("parent cancelled");
      expect(child.state).toBe(ExecutionState.FAILED); // unchanged
    });

    it("already CANCELLED / TIMEOUT children are left alone", () => {
      const root = createRootNode("agent");
      const childCancelled = createChildNode(root, "tool");
      const childTimedOut = createChildNode(root, "tool");

      root.start();
      childCancelled.start();
      childCancelled.cancel("own reason");
      childTimedOut.start();
      childTimedOut.timeout(5000);

      root.cancel("parent cancelled");

      expect(childCancelled.state).toBe(ExecutionState.CANCELLED);
      expect(childTimedOut.state).toBe(ExecutionState.TIMEOUT);
    });
  });

  describe("Cascade through multiple levels", () => {
    it("cancel root → all descendants cancelled", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");
      const grandchild = createChildNode(child, "tool");

      root.start();
      child.start();
      grandchild.start();

      root.cancel("deep abort");

      expect(root.state).toBe(ExecutionState.CANCELLED);
      expect(child.state).toBe(ExecutionState.CANCELLED);
      expect(grandchild.state).toBe(ExecutionState.CANCELLED);
    });

    it("cancel mid-level child → its subtree cancels, siblings unaffected", () => {
      const root = createRootNode("agent");
      const childA = createChildNode(root, "tool");
      const childB = createChildNode(root, "tool");
      const grandchildA = createChildNode(childA, "tool");

      root.start();
      childA.start();
      childB.start();
      grandchildA.start();

      // Cancel childA only — its subtree should cancel
      childA.cancel("child-specific abort");

      expect(childA.state).toBe(ExecutionState.CANCELLED);
      expect(grandchildA.state).toBe(ExecutionState.CANCELLED);
      // Sibling unaffected
      expect(childB.state).toBe(ExecutionState.RUNNING);
    });
  });

  describe("complete() on parent also cancels active children", () => {
    it("parent complete cancels running children", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      root.start();
      child.start();

      root.complete();

      expect(root.state).toBe(ExecutionState.COMPLETED);
      expect(child.state).toBe(ExecutionState.CANCELLED);
    });

    it("parent complete leaves already-terminal children alone", () => {
      const root = createRootNode("agent");
      const childCompleted = createChildNode(root, "tool");
      const childRunning = createChildNode(root, "tool");

      root.start();
      childCompleted.start();
      childCompleted.complete();
      childRunning.start();

      root.complete();

      expect(childCompleted.state).toBe(ExecutionState.COMPLETED);
      expect(childRunning.state).toBe(ExecutionState.CANCELLED);
    });
  });

  describe("fail() on parent cascades to children", () => {
    it("parent fail cancels running children", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      root.start();
      child.start();

      root.fail("parent error");

      expect(root.state).toBe(ExecutionState.FAILED);
      expect(child.state).toBe(ExecutionState.CANCELLED);
    });
  });

  describe("timeout() on parent cascades to children", () => {
    it("parent timeout cancels running children", () => {
      const root = createRootNode("agent");
      const child = createChildNode(root, "tool");

      root.start();
      child.start();

      root.timeout(30000);

      expect(root.state).toBe(ExecutionState.TIMEOUT);
      expect(child.state).toBe(ExecutionState.CANCELLED);
    });
  });

  describe("cascade skips nodes already in terminal state", () => {
    it("mixed children — terminal preserved, non-terminal (RUNNING) cancelled; CREATED children need explicit start", () => {
      // Note: VALID_TRANSITIONS only allows CREATED → RUNNING, so CREATED children
      // cannot be directly transitioned to CANCELLED via cascade. They must be
      // started first (start → RUNNING → cancel → CANCELLED) or handled separately.
      const root = createRootNode("agent");
      const running = createChildNode(root, "tool");
      const completed = createChildNode(root, "tool");
      const failed = createChildNode(root, "tool");
      const cancelled = createChildNode(root, "tool");
      const timedOut = createChildNode(root, "tool");
      // All children are started so cascade works properly
      const createdButStarted = createChildNode(root, "tool");

      root.start();
      running.start();
      completed.start();
      completed.complete();
      failed.start();
      failed.fail("err");
      cancelled.start();
      cancelled.cancel("own");
      timedOut.start();
      timedOut.timeout(1000);
      // createdButStarted is started so cascade works
      createdButStarted.start();

      root.cancel("root cancel");

      expect(running.state).toBe(ExecutionState.CANCELLED);
      expect(createdButStarted.state).toBe(ExecutionState.CANCELLED);
      expect(completed.state).toBe(ExecutionState.COMPLETED);
      expect(failed.state).toBe(ExecutionState.FAILED);
      expect(cancelled.state).toBe(ExecutionState.CANCELLED);
      expect(timedOut.state).toBe(ExecutionState.TIMEOUT);
    });
  });
});

// ═══════════════════════════════════════════════════════
// SHOULD STOP
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — shouldStop", () => {
  it("shouldStop = false when RUNNING and signal not aborted", () => {
    const node = createRootNode("agent");
    node.start();
    expect(node.shouldStop).toBe(false);
  });

  it("shouldStop = false when CREATED (not yet started, not aborted)", () => {
    const node = createRootNode("agent");
    expect(node.shouldStop).toBe(false);
  });

  it("shouldStop = true when CANCELLED", () => {
    const node = createRootNode("agent");
    node.start();
    node.cancel("test");
    expect(node.shouldStop).toBe(true);
  });

  it("shouldStop = true when TIMEOUT", () => {
    const node = createRootNode("agent");
    node.start();
    node.timeout(1000);
    expect(node.shouldStop).toBe(true);
  });

  it("shouldStop = true when signal.aborted (even when RUNNING)", () => {
    const controller = new AbortController();
    const node = createRootNode("agent", controller.signal);
    node.start();
    controller.abort();
    expect(node.shouldStop).toBe(true);
  });

  it("shouldStop = false when COMPLETED (already finished, not 'should stop')", () => {
    const node = createRootNode("agent");
    node.start();
    node.complete();
    expect(node.shouldStop).toBe(false);
  });

  it("shouldStop = false when FAILED (already finished)", () => {
    const node = createRootNode("agent");
    node.start();
    node.fail("err");
    expect(node.shouldStop).toBe(false);
  });

  it("shouldStop = false when CANCELLED child, but parent RUNNING", () => {
    const root = createRootNode("agent");
    const child = createChildNode(root, "tool");
    root.start();
    child.start();
    child.cancel("child cancel");

    expect(child.shouldStop).toBe(true); // child is CANCELLED
    expect(root.shouldStop).toBe(false); // parent still RUNNING
  });

  it("shouldStop = true when signal.aborted before start", () => {
    const controller = new AbortController();
    const node = createRootNode("agent", controller.signal);
    controller.abort();
    // Even in CREATED state with aborted signal
    expect(node.shouldStop).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// LISTENERS
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — Listeners", () => {
  it("onStateChange fires on state transition", () => {
    const node = createRootNode("agent");
    const listener = vi.fn();

    node.onStateChange(listener);
    node.start();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(ExecutionState.RUNNING);
  });

  it("onStateChange fires for every transition", () => {
    const node = createRootNode("agent");
    const listener = vi.fn();

    node.onStateChange(listener);
    node.start();
    node.complete();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0]).toBe(ExecutionState.RUNNING);
    expect(listener.mock.calls[1][0]).toBe(ExecutionState.COMPLETED);
  });

  it("onStateChange returns unsubscribe function that works", () => {
    const node = createRootNode("agent");
    const listener = vi.fn();

    const unsubscribe = node.onStateChange(listener);
    node.start();
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe
    unsubscribe();

    node.complete();
    // Listener should NOT be called again after unsubscribe
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("multiple listeners all fire independently", () => {
    const node = createRootNode("agent");
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    node.onStateChange(listenerA);
    node.onStateChange(listenerB);
    node.start();

    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing one listener does not affect another", () => {
    const node = createRootNode("agent");
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    const unsubA = node.onStateChange(listenerA);
    node.onStateChange(listenerB);

    node.start();
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);

    unsubA();

    node.complete();
    expect(listenerA).toHaveBeenCalledTimes(1); // not called again
    expect(listenerB).toHaveBeenCalledTimes(2); // still called
  });

  it("listener exceptions are silently caught (do not propagate)", () => {
    const node = createRootNode("agent");
    const badListener = vi.fn(() => {
      throw new Error("listener crash");
    });
    const goodListener = vi.fn();

    node.onStateChange(badListener);
    node.onStateChange(goodListener);

    // Should not throw
    node.start();

    // badListener was called (and threw internally)
    expect(badListener).toHaveBeenCalledTimes(1);
    // goodListener still fired after bad one crashed
    expect(goodListener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing the same listener twice is safe (no-op on second)", () => {
    const node = createRootNode("agent");
    const listener = vi.fn();

    const unsubscribe = node.onStateChange(listener);
    unsubscribe();
    // Second unsubscribe — should not throw
    unsubscribe();

    node.start();
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it("listener is not called during cancelActiveChildren cascade", () => {
    // cancelActiveChildren triggers child state changes.
    // These should not be subscribed to parent listeners.
    const root = createRootNode("agent");
    const child = createChildNode(root, "tool");
    const rootListener = vi.fn();

    root.onStateChange(rootListener);
    root.start();
    child.start();
    rootListener.mockClear(); // reset after start

    root.cancel("test");

    // rootListener should fire exactly once (for root's own CANCELLED transition)
    // not for the child's cascade
    expect(rootListener).toHaveBeenCalledTimes(1);
    expect(rootListener).toHaveBeenCalledWith(ExecutionState.CANCELLED);
  });
});

// ═══════════════════════════════════════════════════════
// DURATION
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — Duration", () => {
  it("duration returns 0 when not yet started", () => {
    const node = createRootNode("agent");
    expect(node.duration).toBe(0);
  });

  it("duration returns a positive number when RUNNING", () => {
    const node = createRootNode("agent");
    node.start();
    expect(node.duration).toBeGreaterThanOrEqual(0);
  });

  it("duration returns elapsed time after completion", () => {
    vi.useFakeTimers();
    const node = createRootNode("agent");
    node.start();

    vi.advanceTimersByTime(100);
    node.complete();

    expect(node.duration).toBe(100);
    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════
// BUFFER INTEGRATION
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — Buffer Integration", () => {
  it("node.buffer is an OutputBuffer instance", () => {
    const node = createRootNode("agent");
    expect(node.buffer).toBeInstanceOf(OutputBuffer);
  });

  it("buffer can be injected via constructor", () => {
    const ctx = createRunContext(new AbortController().signal);
    const customBuffer = new OutputBuffer();
    customBuffer.append("prefilled");

    const node = new ExecutionNode("agent", ctx, customBuffer);

    expect(node.buffer.getContent()).toBe("prefilled");
  });

  it("buffer content survives state transitions", () => {
    const node = createRootNode("agent");
    node.buffer.append("Hello, World!");
    node.start();
    node.complete();

    expect(node.buffer.getContent()).toBe("Hello, World!");
  });

  it("each node has an independent buffer", () => {
    const root = createRootNode("agent");
    const child = createChildNode(root, "tool");

    root.buffer.append("root data");
    child.buffer.append("child data");

    expect(root.buffer.getContent()).toBe("root data");
    expect(child.buffer.getContent()).toBe("child data");
  });
});

// ═══════════════════════════════════════════════════════
// isTerminal
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — isTerminal", () => {
  it("isTerminal is false when CREATED", () => {
    const node = createRootNode("agent");
    expect(node.isTerminal).toBe(false);
  });

  it("isTerminal is false when RUNNING", () => {
    const node = createRootNode("agent");
    node.start();
    expect(node.isTerminal).toBe(false);
  });

  it.each([
    [
      "COMPLETED",
      () => {
        const n = createRootNode("agent");
        n.start();
        n.complete();
        return n;
      },
    ],
    [
      "FAILED",
      () => {
        const n = createRootNode("agent");
        n.start();
        n.fail("err");
        return n;
      },
    ],
    [
      "CANCELLED",
      () => {
        const n = createRootNode("agent");
        n.start();
        n.cancel("r");
        return n;
      },
    ],
    [
      "TIMEOUT",
      () => {
        const n = createRootNode("agent");
        n.start();
        n.timeout(1000);
        return n;
      },
    ],
  ])("isTerminal is true when %s", (_label, factory) => {
    const node = factory();
    expect(node.isTerminal).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// DEPRECATED API — interrupt()
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — interrupt() (deprecated)", () => {
  it("interrupt() delegates to cancel()", () => {
    const node = createRootNode("agent");
    node.start();

    const result = node.interrupt();

    expect(node.state).toBe(ExecutionState.CANCELLED);
    expect(result.termination).toBe(RunTermination.Cancelled);
  });

  it("interrupt() cascades to children", () => {
    const root = createRootNode("agent");
    const child = createChildNode(root, "tool");

    root.start();
    child.start();

    root.interrupt();

    expect(root.state).toBe(ExecutionState.CANCELLED);
    expect(child.state).toBe(ExecutionState.CANCELLED);
  });
});

// ═══════════════════════════════════════════════════════
// EXECUTION TYPE
// ═══════════════════════════════════════════════════════

describe("ExecutionNode — ExecutionType", () => {
  it.each(["chat", "agent", "tool", "workflow", "voice", "subagent"] as const)(
    "accepts ExecutionType '%s'",
    (type) => {
      const node = createRootNode(type);
      expect(node.type).toBe(type);
    },
  );
});
