// ExecutionController — 纯生命周期管理，不依赖持久化
//
// 设计要点：
// - complete/interrupt/fail 只做状态转移 + 返回 buffer 内容
// - 不做任何 DB 写入。持久化由上层 Service 决定。
// - shouldStop 统一入口：检查 signal.aborted 或 Interrupting 状态
// - 状态转移校验合法性，拒绝非法跳转

import type { RunContext } from "./context.js";
import { OutputBuffer } from "./buffer.js";

// ═══════════════════════════════════════════════════════
// 运行时状态机
// ═══════════════════════════════════════════════════════

export enum RunState {
  Pending = "pending",
  Running = "running",
  /** 过渡态：用户点了停止，LLM/Tool 可能还在收尾 */
  Interrupting = "interrupting",
  /** 终端态 */
  Completed = "completed",
  Interrupted = "interrupted",
  Failed = "failed",
}

/** 终端态集合 */
const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  RunState.Completed,
  RunState.Interrupted,
  RunState.Failed,
]);

// ═══════════════════════════════════════════════════════
// 状态转移表
// ═══════════════════════════════════════════════════════

const VALID_TRANSITIONS: ReadonlyMap<RunState, ReadonlySet<RunState>> = new Map([
  [RunState.Pending, new Set([RunState.Running])],
  [RunState.Running, new Set([RunState.Completed, RunState.Failed, RunState.Interrupting])],
  [RunState.Interrupting, new Set([RunState.Interrupted])],
  // 终端态不可再转移
  [RunState.Completed, new Set()],
  [RunState.Interrupted, new Set()],
  [RunState.Failed, new Set()],
]);

// ═══════════════════════════════════════════════════════
// RunTermination
// ═══════════════════════════════════════════════════════

export enum RunTermination {
  Completed = "completed",
  Interrupted = "interrupted",
  Failed = "failed",
}

/** RunResult 不携带 output——内容从 OutputBuffer.getContent() 获取 */
export interface RunResult {
  termination: RunTermination;
  error?: string;
}

// ═══════════════════════════════════════════════════════
// ExecutionController
// ═══════════════════════════════════════════════════════

export class ExecutionController {
  readonly context: RunContext;
  readonly buffer: OutputBuffer;

  private _state: RunState = RunState.Pending;
  private listeners = new Set<(state: RunState) => void>();

  constructor(context: RunContext, buffer?: OutputBuffer) {
    this.context = context;
    this.buffer = buffer ?? new OutputBuffer();
  }

  // ── 状态查询 ──

  get state(): RunState {
    return this._state;
  }

  /** 是否为终端态 */
  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this._state);
  }

  /** 是否应该停止：signal 已触发 或 正在中断中 */
  get shouldStop(): boolean {
    return (
      this.context.signal.aborted ||
      this._state === RunState.Interrupting ||
      this._state === RunState.Interrupted
    );
  }

  // ── 状态监听 ──

  /** 注册状态变更监听器（返回取消注册函数） */
  onStateChange(fn: (state: RunState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // ── 生命周期方法 ──

  /** 开始执行：Pending → Running */
  start(): void {
    this.setState(RunState.Running);
  }

  /** 正常完成：Running → Completed */
  complete(): RunResult {
    this.setState(RunState.Completed);
    return {
      termination: RunTermination.Completed,
    };
  }

  /**
   * 中断执行：Running → Interrupting → Interrupted
   * 可重复调用（幂等）：如果已经是 Interrupted 则直接返回
   */
  interrupt(): RunResult {
    if (this._state === RunState.Interrupted) {
      return {
        termination: RunTermination.Interrupted,
      };
    }
    if (this._state === RunState.Running) {
      this.setState(RunState.Interrupting);
    }
    if (this._state === RunState.Interrupting) {
      this.setState(RunState.Interrupted);
    }
    return {
      termination: RunTermination.Interrupted,
    };
  }

  /** 异常失败：Running → Failed */
  fail(error: string): RunResult {
    this.setState(RunState.Failed);
    return {
      termination: RunTermination.Failed,
      error,
    };
  }

  // ── 内部方法 ──

  private setState(newState: RunState): void {
    const allowed = VALID_TRANSITIONS.get(this._state);
    if (!allowed?.has(newState)) {
      throw new Error(
        `[ExecutionController] Invalid state transition: ${this._state} → ${newState}`,
      );
    }
    this._state = newState;
    this.notifyListeners(newState);
  }

  private notifyListeners(state: RunState): void {
    for (const fn of this.listeners) {
      try {
        fn(state);
      } catch {
        // 监听器异常不影响 Runtime
      }
    }
  }
}
