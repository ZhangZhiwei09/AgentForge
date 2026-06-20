// ExecutionScope — 聚合入口
//
// 一个 createExecutionScope() 调用返回完整的 { context, node, buffer }。
// ExecutionNode 是 ExecutionController 的演化版本，统一了状态机 + 树结构。
// 未来 Tracing / Metrics / Logger 直接往 Scope 加字段，
// 不用全项目到处传多个独立参数。

import { createRunContext, createChildContext, type RunContext } from "./context.js";
import { OutputBuffer } from "./buffer.js";
import { ExecutionNode, type ExecutionType } from "./controller.js";
import type { ObservabilityTrace } from "../observability/provider.js";

export interface ExecutionScope {
  readonly context: RunContext;
  readonly node: ExecutionNode;
  readonly buffer: OutputBuffer;

  /** @deprecated Use node instead */
  readonly controller: ExecutionNode;

  /** 可观测性 Trace（创建时注入，readonly，下游只读） */
  readonly trace?: ObservabilityTrace;
}

export interface CreateScopeOptions {
  /** AbortSignal（通常来自 c.req.raw.signal） */
  signal: AbortSignal;
  /** 父 Context（SubAgent / 嵌套调用场景） */
  parentContext?: RunContext;
  /** 自定义 runId（测试 / replay 场景） */
  runId?: string;
  /** 执行类型 */
  executionType?: ExecutionType;
  /** 可观测性 Trace（创建时注入，之后只读。默认 undefined） */
  trace?: ObservabilityTrace;
}

/**
 * 创建执行域。
 * 所有流式执行（Chat / CustomerChat / Agent / Workflow / Voice）的入口工厂。
 */
export function createExecutionScope(options: CreateScopeOptions): ExecutionScope {
  const context = options.parentContext
    ? createChildContext(options.parentContext, options.runId)
    : createRunContext(options.signal, options.runId);

  const buffer = new OutputBuffer();
  const node = new ExecutionNode(
    options.executionType ?? "chat",
    context,
    buffer,
  );

  return {
    context,
    node,
    buffer,
    // 向后兼容：保留 controller 引用
    controller: node,
    // 可观测性 Trace（创建时注入）
    trace: options.trace,
  };
}
