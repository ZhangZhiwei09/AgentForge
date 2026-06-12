// Workflow shared types — V6 Workflow Engine
// Used by both server and frontend

export interface WorkflowVariableDef {
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface StepRetryConfig {
  maxAttempts: number;
  backoff: "fixed" | "exponential" | "linear";
  initialDelay: number;
  maxDelay: number;
  retryOn: string[];
}

export type StepType = "agent" | "tool" | "condition" | "parallel" | "human_approval" | "transform";

export interface BaseStep {
  id: string;
  type: StepType;
  description?: string;
  depends_on?: string[];
  retry?: StepRetryConfig;
  timeout?: number;
  on_timeout?: "fail" | "skip" | "fallback";
  fallback_step?: string;
}

export interface AgentStep extends BaseStep {
  type: "agent";
  prompt: string;
  system_prompt?: string;
  model?: string;
  tools?: string[];
  max_iterations?: number;
  output_as?: string;
}

export interface ToolStep extends BaseStep {
  type: "tool";
  tool: string;
  args?: Record<string, unknown>;
  require_approval?: boolean;
  output_as?: string;
}

export interface ConditionStep extends BaseStep {
  type: "condition";
  expression: string;
  branches: Record<string, WorkflowStep[]>;
  default_branch?: string;
}

export interface ParallelBranch {
  id: string;
  label?: string;
  steps: WorkflowStep[];
}

export interface ParallelStep extends BaseStep {
  type: "parallel";
  branches: ParallelBranch[];
  wait?: "all" | "any" | "first";
}

export interface HumanApprovalStep extends BaseStep {
  type: "human_approval";
  message: string;
  details?: Record<string, unknown>;
  timeout_seconds?: number;
  on_reject?: "skip" | "fail";
}

export interface TransformStep extends BaseStep {
  type: "transform";
  operation: "map" | "filter" | "merge" | "jsonata";
  expression: string;
  input?: string;
  output_as?: string;
}

export type WorkflowStep =
  | AgentStep
  | ToolStep
  | ConditionStep
  | ParallelStep
  | HumanApprovalStep
  | TransformStep;

export interface WorkflowDefinition {
  name: string;
  version?: string;
  description?: string;
  variables?: Record<string, WorkflowVariableDef>;
  steps: WorkflowStep[];
  on_failure?: "stop" | "continue" | "rollback";
  max_concurrency?: number;
}

export type WorkflowStatus = "draft" | "ready" | "archived";

export interface WorkflowDTO {
  id: string;
  userId: string;
  name: string;
  description?: string;
  definition: WorkflowDefinition;
  version: number;
  status: WorkflowStatus;
  tags: string[];
  runCount: number;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowRunStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export interface StepResult {
  status: "completed" | "failed" | "skipped";
  output: unknown;
  error?: string;
  retryCount?: number;
  durationMs?: number;
  tokensUsed?: number;
  reason?: string;
}

export interface WorkflowCheckpoint {
  workflowId: string;
  runId: string;
  completedSteps: string[];
  currentStep: string | null;
  pendingSteps: string[];
  stepResults: Record<string, StepResult>;
  variables: Record<string, unknown>;
  savedAt: string;
}

export interface ProgressSummary {
  completed: number;
  total: number;
  failed: number;
  skipped: number;
  running: number;
}

export interface WorkflowRunDTO {
  id: string;
  workflowId: string;
  userId: string;
  status: WorkflowRunStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  checkpoint?: WorkflowCheckpoint;
  currentStepId?: string;
  progress: ProgressSummary;
  error?: string;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
}

export type WorkflowStepLogStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface WorkflowStepLogDTO {
  id: string;
  runId: string;
  stepId: string;
  stepType: StepType;
  status: WorkflowStepLogStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  retryCount: number;
  durationMs?: number;
  tokensUsed: number;
  events?: unknown[];
  startedAt?: string;
  completedAt?: string;
}

// SSE event types for workflow streaming
export type WorkflowStreamEvent =
  | WorkflowStartedEvent
  | WorkflowStepStartedEvent
  | WorkflowStepProgressEvent
  | WorkflowStepCompletedEvent
  | WorkflowStepFailedEvent
  | WorkflowPausedEvent
  | WorkflowResumedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | WorkflowCancelledEvent
  | WorkflowApprovalRequiredEvent;

export interface WorkflowStartedEvent {
  type: "workflow_started";
  runId: string;
  workflowName: string;
  totalSteps: number;
}

export interface WorkflowStepStartedEvent {
  type: "workflow_step_started";
  stepId: string;
  stepType: StepType;
  input?: unknown;
}

export interface WorkflowStepProgressEvent {
  type: "workflow_step_progress";
  stepId: string;
  agentEvent?: unknown;
}

export interface WorkflowStepCompletedEvent {
  type: "workflow_step_completed";
  stepId: string;
  status: string;
  output?: unknown;
  durationMs?: number;
}

export interface WorkflowStepFailedEvent {
  type: "workflow_step_failed";
  stepId: string;
  error: string;
  retryCount?: number;
  nextRetryMs?: number;
}

export interface WorkflowPausedEvent {
  type: "workflow_paused";
  runId: string;
  reason: string;
  stepId?: string;
}

export interface WorkflowResumedEvent {
  type: "workflow_resumed";
  runId: string;
  resumedFrom?: string;
}

export interface WorkflowCompletedEvent {
  type: "workflow_completed";
  runId: string;
  output?: unknown;
  totalDurationMs?: number;
  stepSummary?: ProgressSummary;
}

export interface WorkflowFailedEvent {
  type: "workflow_failed";
  runId: string;
  error: string;
  failedStepId?: string;
  checkpoint?: WorkflowCheckpoint;
}

export interface WorkflowCancelledEvent {
  type: "workflow_cancelled";
  runId: string;
  cancelledBy?: string;
}

export interface WorkflowApprovalRequiredEvent {
  type: "workflow_approval_required";
  runId: string;
  stepId: string;
  message: string;
  details?: Record<string, unknown>;
  timeoutSeconds: number;
}
