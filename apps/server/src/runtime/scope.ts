// ExecutionScope — 聚合入口
//
// 一个 createExecutionScope() 调用返回完整的 { context, controller, buffer }。
// 未来 Tracing / Metrics / Logger 直接往 Scope 加字段，
// 不用全项目到处传多个独立参数。

import { createRunContext, createChildContext, type RunContext } from "./context.js";
import { OutputBuffer } from "./buffer.js";
import { ExecutionController } from "./controller.js";

export interface ExecutionScope {
  readonly context: RunContext;
  readonly controller: ExecutionController;
  readonly buffer: OutputBuffer;
}

export interface CreateScopeOptions {
  /** AbortSignal（通常来自 c.req.raw.signal） */
  signal: AbortSignal;
  /** 父 Context（SubAgent / 嵌套调用场景） */
  parentContext?: RunContext;
  /** 自定义 runId（测试 / replay 场景） */
  runId?: string;
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
  const controller = new ExecutionController(context, buffer);

  return { context, controller, buffer };
}
