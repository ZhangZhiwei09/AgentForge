// ExecutionNode — Runtime Root Primitive
//
// 设计要点：
// - 聚合 ExecutionState 状态机 + 树结构 + RunContext 身份
// - complete/interrupt/fail 只做状态转移；持久化由上层 Service 决定
// - shouldStop 统一入口：检查 signal.aborted 或 Interrupting 状态
// - 状态转移校验合法性，拒绝非法跳转
// - 父取消自动级联到所有子节点
//
// V1 阶段：ExecutionNode 承担状态机 + 树管理 + 事件预留
// 未来当子模块逻辑超过 ~50 行时，拆分为 LifecycleManager / ChildManager / EventEmitter

import type { RunContext } from "./context.js";
import { OutputBuffer } from "./buffer.js";
import { ExecutionState, TERMINAL_STATES } from "./results.js";
import type { ExecutionResult } from "./results.js";

// ═══════════════════════════════════════════════════════
// ExecutionType
// ═══════════════════════════════════════════════════════

export type ExecutionType =
  | "chat"
  | "agent"
  | "tool"
  | "workflow"
  | "voice"
  | "subagent";

// ═══════════════════════════════════════════════════════
// 状态转移表
// ═══════════════════════════════════════════════════════

const VALID_TRANSITIONS: ReadonlyMap<ExecutionState, ReadonlySet<ExecutionState>> = new Map([
  [ExecutionState.CREATED, new Set([ExecutionState.RUNNING])],
  [ExecutionState.RUNNING, new Set([ExecutionState.COMPLETED, ExecutionState.FAILED, ExecutionState.CANCELLED, ExecutionState.TIMEOUT])],
  // 终态不可逆（Invariant 3）
  [ExecutionState.COMPLETED, new Set()],
  [ExecutionState.FAILED, new Set()],
  [ExecutionState.CANCELLED, new Set()],
  [ExecutionState.TIMEOUT, new Set()],
]);

// ═══════════════════════════════════════════════════════
// RunTermination
// ═══════════════════════════════════════════════════════

export enum RunTermination {
  Completed = "completed",
  Failed = "failed",
  Cancelled = "cancelled",
  Timeout = "timeout",
}

/** RunResult 不携带 output——内容从 OutputBuffer.getContent() 获取 */
export interface RunResult {
  termination: RunTermination;
  error?: string;
}

// ═══════════════════════════════════════════════════════
// ExecutionNode
// ═══════════════════════════════════════════════════════

export class ExecutionNode {
  readonly id: string;
  readonly type: ExecutionType;
  readonly parent: ExecutionNode | null;
  readonly context: RunContext;
  readonly buffer: OutputBuffer;
  readonly children: ExecutionNode[] = [];

  private _state: ExecutionState = ExecutionState.CREATED;
  private _startedAt: number = 0;
  private _completedAt: number = 0;
  private listeners = new Set<(state: ExecutionState) => void>();

  constructor(
    type: ExecutionType,
    context: RunContext,
    buffer?: OutputBuffer,
    parent?: ExecutionNode,
  ) {
    this.type = type;
    this.id = context.runId;
    this.context = context;
    this.buffer = buffer ?? new OutputBuffer();
    this.parent = parent ?? null;

    // 注册到父节点
    if (parent) {
      parent.children.push(this);
    }
  }

  // ── 状态查询 ──

  get state(): ExecutionState {
    return this._state;
  }

  /** 是否为终端态 */
  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this._state);
  }

  /** 执行耗时（ms）。运行中返回至今耗时，未开始返回 0 */
  get duration(): number {
    if (this._startedAt === 0) return 0;
    if (this._completedAt > 0) return this._completedAt - this._startedAt;
    return Date.now() - this._startedAt;
  }

  /** 是否应该停止：signal 已触发 或 已被取消/超时 */
  get shouldStop(): boolean {
    return (
      this.context.signal.aborted ||
      this._state === ExecutionState.CANCELLED ||
      this._state === ExecutionState.TIMEOUT
    );
  }

  // ── 状态监听 ──

  /** 注册状态变更监听器（返回取消注册函数） */
  onStateChange(fn: (state: ExecutionState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // ── 子节点管理 ──

  /**
   * 创建子 ExecutionNode。
   * 子节点继承父的 context（ancestry 自动追加），拥有独立的 runId。
   * 父取消时自动级联取消所有子节点（Invariant 4）。
   */
  createChild(type: ExecutionType, childRunId?: string): ExecutionNode {
    // createChildContext 自动追加 ancestry
    const { createChildContext } = require("./context.js");
    const childContext = createChildContext(this.context, childRunId);
    return new ExecutionNode(type, childContext, undefined, this);
  }

  // ── 生命周期方法 ──

  /** 开始执行：CREATED → RUNNING */
  start(): void {
    this.setState(ExecutionState.RUNNING);
    this._startedAt = Date.now();
  }

  /**
   * 正常完成：RUNNING → COMPLETED
   * 自动取消所有活跃子节点（Invariant 4：父完成前子节点必须终态）
   */
  complete(result?: ExecutionResult): RunResult {
    this.cancelActiveChildren("parent completed");
    this._completedAt = Date.now();
    this.setState(ExecutionState.COMPLETED);
    return { termination: RunTermination.Completed };
  }

  /** 异常失败：RUNNING → FAILED */
  fail(error: string): RunResult {
    this.cancelActiveChildren("parent failed");
    this._completedAt = Date.now();
    this.setState(ExecutionState.FAILED);
    return { termination: RunTermination.Failed, error };
  }

  /**
   * 取消执行：RUNNING → CANCELLED
   * 级联取消所有子节点。可重复调用（幂等）。
   */
  cancel(reason: string): RunResult {
    if (this._state === ExecutionState.CANCELLED) {
      return { termination: RunTermination.Cancelled };
    }
    this.cancelActiveChildren(reason);
    this._completedAt = Date.now();
    this.setState(ExecutionState.CANCELLED);
    return { termination: RunTermination.Cancelled };
  }

  /** 超时：RUNNING → TIMEOUT */
  timeout(afterMs: number): RunResult {
    this.cancelActiveChildren("parent timed out");
    this._completedAt = Date.now();
    this.setState(ExecutionState.TIMEOUT);
    return { termination: RunTermination.Timeout, error: `Timed out after ${afterMs}ms` };
  }

  // ── 兼容旧 API（逐步迁移期间） ──

  /** @deprecated Use cancel() instead */
  interrupt(): RunResult {
    return this.cancel("interrupted");
  }

  // ── 内部方法 ──

  /** 取消所有活跃子节点 */
  private cancelActiveChildren(reason: string): void {
    for (const child of this.children) {
      if (!child.isTerminal) {
        child.cancel(reason);
      }
    }
  }

  private setState(newState: ExecutionState): void {
    const allowed = VALID_TRANSITIONS.get(this._state);
    if (!allowed?.has(newState)) {
      throw new Error(
        `[ExecutionNode] Invalid state transition: ${this._state} → ${newState}`,
      );
    }
    this._state = newState;
    this.notifyListeners(newState);
  }

  private notifyListeners(state: ExecutionState): void {
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch {
        // 监听器异常不影响 Runtime
      }
    }
  }
}
