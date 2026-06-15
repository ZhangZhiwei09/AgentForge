// RunContext — 不可变运行时上下文，支持运行树
//
// 设计要点：
// - 全部字段 readonly + Object.freeze()，防止 Tool/Agent 污染上游
// - ancestry 替代 parentRunId：数组直接表达完整运行树
// - createChildContext() 由调用者决定何时创建，不由底层自动生成

export interface RunContext {
  /** 取消信号，贯穿全链路 */
  readonly signal: AbortSignal;
  /** 本次执行的唯一 ID */
  readonly runId: string;
  /** 运行树路径：从根到当前节点。
   *  例: ["root-chat-001", "agent-002", "tool-search-003"]
   *  Tracing / Replay / Debug 直接读取此数组重建运行树 */
  readonly ancestry: string[];
}

/**
 * 创建根 RunContext。
 * Chat / CustomerChat / Workflow 入口调用。
 */
export function createRunContext(
  signal: AbortSignal,
  runId?: string,
): RunContext {
  const id = runId ?? crypto.randomUUID();
  return Object.freeze({
    signal,
    runId: id,
    ancestry: [id],
  });
}

/**
 * 创建子 RunContext。
 * Agent 调用 Tool / SubAgent 时，由调用者调用此函数创建子 Context。
 * 子 Context 继承父的 signal，拥有独立的 runId，
 * ancestry 自动追加，形成完整运行树。
 */
export function createChildContext(
  parent: RunContext,
  childRunId?: string,
): RunContext {
  const id = childRunId ?? crypto.randomUUID();
  return Object.freeze({
    signal: parent.signal,
    runId: id,
    ancestry: [...parent.ancestry, id],
  });
}
