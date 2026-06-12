// Workflow DSL Schema — Zod validation for workflow definitions
// Validates the JSON DSL against the V6 Workflow Engine specification
import { z } from "zod";

// ---- Retry Config ----

export const StepRetrySchema = z.object({
  maxAttempts: z.number().min(1).max(10).default(3),
  backoff: z.enum(["fixed", "exponential", "linear"]).default("exponential"),
  initialDelay: z.number().min(0).default(1000),
  maxDelay: z.number().min(0).default(60000),
  retryOn: z.array(z.string()).default(["*"]),
});

// ---- Base Step ----

export const BaseStepSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  retry: StepRetrySchema.optional(),
  timeout: z.number().min(1).max(600).default(60),
  on_timeout: z.enum(["fail", "skip", "fallback"]).default("fail"),
  fallback_step: z.string().optional(),
});

// ---- Agent Step ----

export const AgentStepSchema = BaseStepSchema.extend({
  type: z.literal("agent"),
  prompt: z.string().min(1),
  system_prompt: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  max_iterations: z.number().min(1).max(20).default(10),
  output_as: z.string().optional(),
});

// ---- Tool Step ----

export const ToolStepSchema = BaseStepSchema.extend({
  type: z.literal("tool"),
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  require_approval: z.boolean().default(false),
  output_as: z.string().optional(),
});

// ---- Condition Step ----

// Recursive step schema for condition branches
const StepSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("type", [
    AgentStepSchema,
    ToolStepSchema,
    ConditionStepSchemaLazy,
    ParallelStepSchemaLazy,
    HumanApprovalStepSchema,
    TransformStepSchema,
  ])
);

const ConditionStepSchemaLazy = BaseStepSchema.extend({
  type: z.literal("condition"),
  expression: z.string().min(1),
  branches: z.record(z.string(), z.array(StepSchema)),
  default_branch: z.string().optional(),
});

const ParallelStepSchemaLazy = BaseStepSchema.extend({
  type: z.literal("parallel"),
  branches: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().optional(),
      steps: z.array(StepSchema),
    })
  ),
  wait: z.enum(["all", "any", "first"]).default("all"),
});

export const ConditionStepSchema = ConditionStepSchemaLazy;
export const ParallelStepSchema = ParallelStepSchemaLazy;

// ---- Human Approval Step ----

export const HumanApprovalStepSchema = BaseStepSchema.extend({
  type: z.literal("human_approval"),
  message: z.string().min(1),
  details: z.record(z.unknown()).optional(),
  timeout_seconds: z.number().min(10).max(3600).default(300),
  on_reject: z.enum(["skip", "fail"]).default("skip"),
});

// ---- Transform Step ----

export const TransformStepSchema = BaseStepSchema.extend({
  type: z.literal("transform"),
  operation: z.enum(["map", "filter", "merge", "jsonata"]),
  expression: z.string().min(1),
  input: z.string().optional(),
  output_as: z.string().optional(),
});

// ---- Workflow Step (Discriminated Union) ----

export const WorkflowStepSchema = z.discriminatedUnion("type", [
  AgentStepSchema,
  ToolStepSchema,
  ConditionStepSchema,
  ParallelStepSchema,
  HumanApprovalStepSchema,
  TransformStepSchema,
]);

// ---- Variable Definition ----

export const VariableDefSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

// ---- Full Workflow Definition ----

export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().default("1.0"),
  description: z.string().optional(),
  variables: z.record(z.string(), VariableDefSchema).default({}),
  steps: z.array(WorkflowStepSchema).min(1, "Workflow must have at least one step"),
  on_failure: z.enum(["stop", "continue", "rollback"]).default("stop"),
  max_concurrency: z.number().min(1).max(10).default(4),
});

// ---- API Request Schemas ----

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  definition: WorkflowDefinitionSchema,
  tags: z.array(z.string()).default([]),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  definition: WorkflowDefinitionSchema.optional(),
  tags: z.array(z.string()).optional(),
});

export const RunWorkflowSchema = z.object({
  variables: z.record(z.unknown()).default({}),
});

export const ApprovalDecisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  modified_args: z.record(z.unknown()).optional(),
  rejection_reason: z.string().max(500).optional(),
});

// ---- Type exports ----

export type ValidatedStepRetry = z.infer<typeof StepRetrySchema>;
export type ValidatedWorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type ValidatedWorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type ValidatedCreateWorkflow = z.infer<typeof CreateWorkflowSchema>;
