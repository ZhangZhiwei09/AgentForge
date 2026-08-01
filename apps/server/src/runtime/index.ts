export {
  createRunContext,
  createChildContext,
  type RunContext,
} from "./context.js";

export { OutputBuffer } from "./buffer.js";

export {
  ExecutionNode,
  type ExecutionType,
  RunTermination,
  type RunResult,
} from "./controller.js";

// Backward compat: ExecutionController is now ExecutionNode
export { ExecutionNode as ExecutionController } from "./controller.js";

export {
  createExecutionScope,
  type ExecutionScope,
  type CreateScopeOptions,
} from "./scope.js";

// ExecutionResult — unified result protocol
export {
  ExecutionState,
  ExecutionErrorCode,
  type ExecutionError,
  type ExecutionResult,
  successResult,
  partialResult,
  failedResult,
  cancelledResult,
  timeoutResult,
  executionResultToContent,
  isDegradedResult,
  isRetryableResult,
} from "./results.js";

// Backward compat: RunState is now ExecutionState
export { ExecutionState as RunState } from "./results.js";
