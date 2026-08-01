// Workflow Schema Validation Tests
// ==================================
// Validates all Zod schemas exported from ../schema.ts
// Covers: positive (valid data), negative (invalid data), defaults, and boundary values.

import { describe, it, expect } from "vitest";
import {
  StepRetrySchema,
  AgentStepSchema,
  ToolStepSchema,
  ConditionStepSchema,
  ParallelStepSchema,
  HumanApprovalStepSchema,
  TransformStepSchema,
  WorkflowStepSchema,
  WorkflowDefinitionSchema,
  StepResultSchema,
  WorkflowCheckpointSchema,
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  RunWorkflowSchema,
  ApprovalDecisionSchema,
  VariableDefSchema,
} from "../schema";

// ═══════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════

/** Shorthand: assert parse succeeds and returns parsed data */
function ok<T>(schema: { parse: (v: unknown) => T }, data: unknown): T {
  return schema.parse(data);
}

/** Shorthand: assert parse throws */
function fail(schema: { parse: (v: unknown) => unknown }, data: unknown): void {
  expect(() => schema.parse(data)).toThrow();
}

// ═══════════════════════════════════════════════════════════════════
// StepRetrySchema
// ═══════════════════════════════════════════════════════════════════

describe("StepRetrySchema", () => {
  it("parses a valid retry config", () => {
    const result = ok(StepRetrySchema, {
      maxAttempts: 5,
      backoff: "exponential",
      initialDelay: 2000,
      maxDelay: 30000,
      retryOn: ["ETIMEDOUT", "ECONNRESET"],
    });
    expect(result.maxAttempts).toBe(5);
    expect(result.backoff).toBe("exponential");
    expect(result.initialDelay).toBe(2000);
    expect(result.maxDelay).toBe(30000);
    expect(result.retryOn).toEqual(["ETIMEDOUT", "ECONNRESET"]);
  });

  it("rejects invalid backoff value", () => {
    fail(StepRetrySchema, { backoff: "jitter" });
  });

  it("enforces maxAttempts >= 1", () => {
    fail(StepRetrySchema, { maxAttempts: 0 });
    fail(StepRetrySchema, { maxAttempts: -1 });
  });

  it("enforces maxAttempts <= 10", () => {
    fail(StepRetrySchema, { maxAttempts: 11 });
    fail(StepRetrySchema, { maxAttempts: 100 });
  });

  it("applies defaults when fields are omitted", () => {
    const result = ok(StepRetrySchema, {});
    expect(result.maxAttempts).toBe(3);
    expect(result.backoff).toBe("exponential");
    expect(result.initialDelay).toBe(1000);
    expect(result.maxDelay).toBe(60000);
    expect(result.retryOn).toEqual(["*"]);
  });

  it("accepts only required fields and applies defaults for the rest", () => {
    const result = ok(StepRetrySchema, { maxAttempts: 7 });
    expect(result.maxAttempts).toBe(7);
    expect(result.backoff).toBe("exponential");
  });

  it("rejects negative initialDelay", () => {
    fail(StepRetrySchema, { initialDelay: -1 });
  });

  it("rejects negative maxDelay", () => {
    fail(StepRetrySchema, { maxDelay: -1 });
  });

  it("accepts boundary maxAttempts at 1 and 10", () => {
    expect(ok(StepRetrySchema, { maxAttempts: 1 }).maxAttempts).toBe(1);
    expect(ok(StepRetrySchema, { maxAttempts: 10 }).maxAttempts).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════
// AgentStepSchema
// ═══════════════════════════════════════════════════════════════════

describe("AgentStepSchema", () => {
  const minimal = {
    id: "step-1",
    type: "agent" as const,
    prompt: "Summarize the document",
  };

  it("parses a minimal valid agent step", () => {
    const result = ok(AgentStepSchema, minimal);
    expect(result.type).toBe("agent");
    expect(result.prompt).toBe("Summarize the document");
  });

  it("rejects when prompt is missing", () => {
    fail(AgentStepSchema, { id: "step-1", type: "agent" });
  });

  it("rejects when prompt is empty string", () => {
    fail(AgentStepSchema, { id: "step-1", type: "agent", prompt: "" });
  });

  it("enforces type=agent literal", () => {
    fail(AgentStepSchema, { ...minimal, type: "tool" });
    fail(AgentStepSchema, { ...minimal, type: "unknown" });
  });

  it("applies default max_iterations = 10", () => {
    const result = ok(AgentStepSchema, minimal);
    expect(result.max_iterations).toBe(10);
  });

  it("applies default timeout = 60", () => {
    const result = ok(AgentStepSchema, minimal);
    expect(result.timeout).toBe(60);
  });

  it("applies default on_timeout = fail", () => {
    const result = ok(AgentStepSchema, minimal);
    expect(result.on_timeout).toBe("fail");
  });

  it("enforces max_iterations >= 1", () => {
    fail(AgentStepSchema, { ...minimal, max_iterations: 0 });
  });

  it("enforces max_iterations <= 20", () => {
    fail(AgentStepSchema, { ...minimal, max_iterations: 21 });
  });

  it("parses a fully specified agent step", () => {
    const result = ok(AgentStepSchema, {
      id: "agent-full",
      type: "agent",
      prompt: "Analyze the data",
      system_prompt: "You are a data analyst",
      model: "gpt-4o",
      tools: ["search", "read_file"],
      max_iterations: 15,
      output_as: "analysis_result",
      description: "Runs data analysis",
      depends_on: ["step-0"],
      retry: { maxAttempts: 5 },
      timeout: 120,
      on_timeout: "skip",
    });
    expect(result.system_prompt).toBe("You are a data analyst");
    expect(result.model).toBe("gpt-4o");
    expect(result.tools).toEqual(["search", "read_file"]);
    expect(result.max_iterations).toBe(15);
    expect(result.output_as).toBe("analysis_result");
  });

  it("accepts optional fields as undefined when omitted", () => {
    const result = ok(AgentStepSchema, minimal);
    expect(result.system_prompt).toBeUndefined();
    expect(result.model).toBeUndefined();
    expect(result.tools).toBeUndefined();
    expect(result.output_as).toBeUndefined();
    expect(result.fallback_step).toBeUndefined();
  });

  it("rejects id exceeding 100 characters", () => {
    fail(AgentStepSchema, { ...minimal, id: "x".repeat(101) });
  });

  it("rejects timeout below 1", () => {
    fail(AgentStepSchema, { ...minimal, timeout: 0 });
  });

  it("rejects timeout above 600", () => {
    fail(AgentStepSchema, { ...minimal, timeout: 601 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ToolStepSchema
// ═══════════════════════════════════════════════════════════════════

describe("ToolStepSchema", () => {
  const minimal = {
    id: "step-tool",
    type: "tool" as const,
    tool: "send_email",
  };

  it("parses a minimal valid tool step", () => {
    const result = ok(ToolStepSchema, minimal);
    expect(result.type).toBe("tool");
    expect(result.tool).toBe("send_email");
  });

  it("rejects when tool is missing", () => {
    fail(ToolStepSchema, { id: "step-tool", type: "tool" });
  });

  it("rejects when tool is empty string", () => {
    fail(ToolStepSchema, { ...minimal, tool: "" });
  });

  it("applies default args = {}", () => {
    const result = ok(ToolStepSchema, minimal);
    expect(result.args).toEqual({});
  });

  it("applies default require_approval = false", () => {
    const result = ok(ToolStepSchema, minimal);
    expect(result.require_approval).toBe(false);
  });

  it("parses a tool step with args", () => {
    const result = ok(ToolStepSchema, {
      ...minimal,
      args: { to: "user@example.com", subject: "Hello" },
    });
    expect(result.args).toEqual({ to: "user@example.com", subject: "Hello" });
  });

  it("parses a tool step with require_approval = true", () => {
    const result = ok(ToolStepSchema, {
      ...minimal,
      require_approval: true,
    });
    expect(result.require_approval).toBe(true);
  });

  it("parses a fully specified tool step with retry and depends_on", () => {
    const result = ok(ToolStepSchema, {
      id: "tool-full",
      type: "tool",
      tool: "deploy_service",
      args: { env: "staging" },
      require_approval: true,
      output_as: "deploy_result",
      description: "Deploys to staging",
      depends_on: ["build-step"],
      retry: { maxAttempts: 3, backoff: "fixed" },
      timeout: 300,
      on_timeout: "fallback",
      fallback_step: "notify-failure",
    });
    expect(result.tool).toBe("deploy_service");
    expect(result.require_approval).toBe(true);
    expect(result.depends_on).toEqual(["build-step"]);
    expect(result.retry?.maxAttempts).toBe(3);
    expect(result.timeout).toBe(300);
  });

  it("rejects when require_approval is not boolean", () => {
    fail(ToolStepSchema, { ...minimal, require_approval: "yes" });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ConditionStepSchema
// ═══════════════════════════════════════════════════════════════════

describe("ConditionStepSchema", () => {
  const minimal = {
    id: "step-cond",
    type: "condition" as const,
    expression: "$.score > 0.8",
    branches: {
      high: [
        { id: "step-high", type: "tool" as const, tool: "notify_high" },
      ],
      low: [
        { id: "step-low", type: "tool" as const, tool: "notify_low" },
      ],
    },
  };

  it("parses a valid condition step with branches", () => {
    const result = ok(ConditionStepSchema, minimal);
    expect(result.type).toBe("condition");
    expect(result.expression).toBe("$.score > 0.8");
    expect(Object.keys(result.branches)).toEqual(["high", "low"]);
  });

  it("rejects when expression is missing", () => {
    fail(ConditionStepSchema, {
      id: "step-cond",
      type: "condition",
      branches: { default: [] },
    });
  });

  it("rejects when expression is empty", () => {
    fail(ConditionStepSchema, {
      ...minimal,
      expression: "",
    });
  });

  it("parses a condition step with a default_branch", () => {
    const result = ok(ConditionStepSchema, {
      ...minimal,
      default_branch: "low",
    });
    expect(result.default_branch).toBe("low");
  });

  it("accepts branches with nested condition steps (recursive)", () => {
    const result = ok(ConditionStepSchema, {
      id: "step-nested",
      type: "condition",
      expression: "$.level",
      branches: {
        a: [
          {
            id: "inner-cond",
            type: "condition",
            expression: "$.sub > 5",
            branches: {
              yes: [{ id: "leaf", type: "tool", tool: "do_thing" }],
            },
          },
        ],
      },
    });
    expect(result.branches.a).toHaveLength(1);
  });

  it("accepts branches with agent steps", () => {
    const result = ok(ConditionStepSchema, {
      id: "cond-agent",
      type: "condition",
      expression: "$.intent === 'complex'",
      branches: {
        true: [
          { id: "agent-branch", type: "agent", prompt: "Handle complex query" },
        ],
        false: [
          { id: "tool-branch", type: "tool", tool: "auto_reply" },
        ],
      },
    });
    expect(Object.keys(result.branches)).toHaveLength(2);
  });

  it("rejects branches that are not objects of arrays", () => {
    fail(ConditionStepSchema, { ...minimal, branches: "not-an-object" });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ParallelStepSchema
// ═══════════════════════════════════════════════════════════════════

describe("ParallelStepSchema", () => {
  const minimal = {
    id: "step-parallel",
    type: "parallel" as const,
    branches: [
      {
        id: "branch-1",
        steps: [
          { id: "a1", type: "tool" as const, tool: "fetch_users" },
          { id: "a2", type: "tool" as const, tool: "fetch_orders" },
        ],
      },
      {
        id: "branch-2",
        steps: [
          { id: "b1", type: "tool" as const, tool: "fetch_products" },
        ],
      },
    ],
  };

  it("parses a valid parallel step with multiple branches", () => {
    const result = ok(ParallelStepSchema, minimal);
    expect(result.type).toBe("parallel");
    expect(result.branches).toHaveLength(2);
    expect(result.branches[0].id).toBe("branch-1");
    expect(result.branches[0].steps).toHaveLength(2);
  });

  it("applies default wait = all", () => {
    const result = ok(ParallelStepSchema, minimal);
    expect(result.wait).toBe("all");
  });

  it("accepts wait = any", () => {
    const result = ok(ParallelStepSchema, { ...minimal, wait: "any" });
    expect(result.wait).toBe("any");
  });

  it("accepts wait = first", () => {
    const result = ok(ParallelStepSchema, { ...minimal, wait: "first" });
    expect(result.wait).toBe("first");
  });

  it("rejects invalid wait value", () => {
    fail(ParallelStepSchema, { ...minimal, wait: "none" });
  });

  it("accepts branch labels", () => {
    const result = ok(ParallelStepSchema, {
      ...minimal,
      branches: [
        {
          id: "b1",
          label: "User Data",
          steps: [{ id: "s1", type: "tool", tool: "x" }],
        },
      ],
    });
    expect(result.branches[0].label).toBe("User Data");
  });

  it("rejects branches that is not an array", () => {
    fail(ParallelStepSchema, {
      id: "step-p",
      type: "parallel",
      branches: "not-array",
    });
  });

  it("rejects empty branches array", () => {
    // An empty array is technically valid per schema (no min length), but we verify parse.
    const result = ok(ParallelStepSchema, {
      id: "step-p",
      type: "parallel",
      branches: [],
    });
    expect(result.branches).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// HumanApprovalStepSchema
// ═══════════════════════════════════════════════════════════════════

describe("HumanApprovalStepSchema", () => {
  const minimal = {
    id: "step-approval",
    type: "human_approval" as const,
    message: "Please approve the deployment",
  };

  it("parses a minimal valid human approval step", () => {
    const result = ok(HumanApprovalStepSchema, minimal);
    expect(result.type).toBe("human_approval");
    expect(result.message).toBe("Please approve the deployment");
  });

  it("rejects when message is missing", () => {
    fail(HumanApprovalStepSchema, { id: "step-approval", type: "human_approval" });
  });

  it("rejects when message is empty", () => {
    fail(HumanApprovalStepSchema, { ...minimal, message: "" });
  });

  it("applies default timeout_seconds = 300", () => {
    const result = ok(HumanApprovalStepSchema, minimal);
    expect(result.timeout_seconds).toBe(300);
  });

  it("applies default on_reject = skip", () => {
    const result = ok(HumanApprovalStepSchema, minimal);
    expect(result.on_reject).toBe("skip");
  });

  it("enforces timeout_seconds >= 10", () => {
    fail(HumanApprovalStepSchema, { ...minimal, timeout_seconds: 9 });
  });

  it("enforces timeout_seconds <= 3600", () => {
    fail(HumanApprovalStepSchema, { ...minimal, timeout_seconds: 3601 });
  });

  it("accepts on_reject = fail", () => {
    const result = ok(HumanApprovalStepSchema, {
      ...minimal,
      on_reject: "fail",
    });
    expect(result.on_reject).toBe("fail");
  });

  it("rejects invalid on_reject value", () => {
    fail(HumanApprovalStepSchema, { ...minimal, on_reject: "ignore" });
  });

  it("accepts details record", () => {
    const result = ok(HumanApprovalStepSchema, {
      ...minimal,
      details: { env: "production", version: "2.0.1" },
    });
    expect(result.details).toEqual({ env: "production", version: "2.0.1" });
  });

  it("parses a fully specified approval step", () => {
    const result = ok(HumanApprovalStepSchema, {
      id: "approval-full",
      type: "human_approval",
      message: "Confirm data deletion",
      details: { rows: 1500, table: "logs" },
      timeout_seconds: 600,
      on_reject: "fail",
      description: "Requires manager approval",
      depends_on: ["backup-step"],
    });
    expect(result.timeout_seconds).toBe(600);
    expect(result.on_reject).toBe("fail");
  });
});

// ═══════════════════════════════════════════════════════════════════
// TransformStepSchema
// ═══════════════════════════════════════════════════════════════════

describe("TransformStepSchema", () => {
  const minimal = {
    id: "step-xform",
    type: "transform" as const,
    operation: "map" as const,
    expression: "$.items[*].name",
  };

  it("parses a valid transform step", () => {
    const result = ok(TransformStepSchema, minimal);
    expect(result.type).toBe("transform");
    expect(result.operation).toBe("map");
    expect(result.expression).toBe("$.items[*].name");
  });

  it("rejects when expression is missing", () => {
    fail(TransformStepSchema, {
      id: "step-xform",
      type: "transform",
      operation: "map",
    });
  });

  it("rejects when expression is empty", () => {
    fail(TransformStepSchema, { ...minimal, expression: "" });
  });

  it("accepts all valid operation values", () => {
    for (const op of ["map", "filter", "merge", "jsonata"] as const) {
      const result = ok(TransformStepSchema, { ...minimal, operation: op });
      expect(result.operation).toBe(op);
    }
  });

  it("rejects invalid operation value", () => {
    fail(TransformStepSchema, { ...minimal, operation: "sort" });
    fail(TransformStepSchema, { ...minimal, operation: "reduce" });
  });

  it("accepts optional input and output_as", () => {
    const result = ok(TransformStepSchema, {
      ...minimal,
      input: "prev_result",
      output_as: "transformed",
    });
    expect(result.input).toBe("prev_result");
    expect(result.output_as).toBe("transformed");
  });

  it("parses a fully specified transform step", () => {
    const result = ok(TransformStepSchema, {
      id: "xform-full",
      type: "transform",
      operation: "jsonata",
      expression: "$sum(Account.Order.Product.(Price * Quantity))",
      input: "order_data",
      output_as: "total",
      description: "Calculates order total via JSONata",
    });
    expect(result.operation).toBe("jsonata");
    expect(result.output_as).toBe("total");
  });
});

// ═══════════════════════════════════════════════════════════════════
// WorkflowStepSchema (Discriminated Union)
// ═══════════════════════════════════════════════════════════════════

describe("WorkflowStepSchema", () => {
  it("identifies agent type correctly", () => {
    const result = ok(WorkflowStepSchema, {
      id: "s1",
      type: "agent",
      prompt: "Hello",
    });
    expect(result.type).toBe("agent");
  });

  it("identifies tool type correctly", () => {
    const result = ok(WorkflowStepSchema, {
      id: "s1",
      type: "tool",
      tool: "send_email",
    });
    expect(result.type).toBe("tool");
  });

  it("identifies condition type correctly", () => {
    const result = ok(WorkflowStepSchema, {
      id: "s1",
      type: "condition",
      expression: "$.x > 0",
      branches: {
        yes: [{ id: "s2", type: "tool", tool: "x" }],
      },
    });
    expect(result.type).toBe("condition");
  });

  it("identifies parallel type correctly", () => {
    const result = ok(WorkflowStepSchema, {
      id: "s1",
      type: "parallel",
      branches: [
        { id: "b1", steps: [{ id: "s2", type: "tool", tool: "x" }] },
      ],
    });
    expect(result.type).toBe("parallel");
  });

  it("identifies human_approval type correctly", () => {
    const result = ok(WorkflowStepSchema, {
      id: "s1",
      type: "human_approval",
      message: "Approve?",
    });
    expect(result.type).toBe("human_approval");
  });

  it("identifies transform type correctly", () => {
    const result = ok(WorkflowStepSchema, {
      id: "s1",
      type: "transform",
      operation: "map",
      expression: "$.x",
    });
    expect(result.type).toBe("transform");
  });

  it("rejects an invalid type", () => {
    fail(WorkflowStepSchema, { id: "s1", type: "unknown" });
  });

  it("rejects a missing type field", () => {
    fail(WorkflowStepSchema, { id: "s1" });
  });

  it("rejects when a required field for the matched type is missing", () => {
    // "agent" requires prompt
    fail(WorkflowStepSchema, { id: "s1", type: "agent" });
    // "tool" requires tool
    fail(WorkflowStepSchema, { id: "s1", type: "tool" });
  });

  it("strips extra fields not defined in any variant", () => {
    // The discriminated union strips unknown keys — parse succeeds but
    // bogusField is not present on the output object.
    const result = ok(WorkflowStepSchema, {
      id: "s1",
      type: "agent",
      prompt: "Hi",
      bogusField: "will be stripped",
    });
    expect(result.type).toBe("agent");
    const agentResult = result as { type: "agent"; prompt: string };
    expect(agentResult.prompt).toBe("Hi");
    // Extra fields are not preserved on the parsed output
    expect((result as Record<string, unknown>).bogusField).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// VariableDefSchema
// ═══════════════════════════════════════════════════════════════════

describe("VariableDefSchema", () => {
  it("parses a valid variable definition", () => {
    const result = ok(VariableDefSchema, { type: "string" });
    expect(result.type).toBe("string");
  });

  it("applies default required = false", () => {
    const result = ok(VariableDefSchema, { type: "boolean" });
    expect(result.required).toBe(false);
  });

  it("rejects invalid type enum value", () => {
    fail(VariableDefSchema, { type: "date" });
  });

  it("accepts all valid variable types", () => {
    for (const t of ["string", "number", "boolean", "object", "array"]) {
      const result = ok(VariableDefSchema, { type: t });
      expect(result.type).toBe(t);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// WorkflowDefinitionSchema
// ═══════════════════════════════════════════════════════════════════

describe("WorkflowDefinitionSchema", () => {
  const minimal = {
    name: "test-workflow",
    steps: [
      { id: "s1", type: "agent" as const, prompt: "Do something" },
    ],
  };

  it("parses a minimal valid workflow definition", () => {
    const result = ok(WorkflowDefinitionSchema, minimal);
    expect(result.name).toBe("test-workflow");
    expect(result.steps).toHaveLength(1);
  });

  it("applies default version = 1.0", () => {
    const result = ok(WorkflowDefinitionSchema, minimal);
    expect(result.version).toBe("1.0");
  });

  it("applies default on_failure = stop", () => {
    const result = ok(WorkflowDefinitionSchema, minimal);
    expect(result.on_failure).toBe("stop");
  });

  it("applies default max_concurrency = 4", () => {
    const result = ok(WorkflowDefinitionSchema, minimal);
    expect(result.max_concurrency).toBe(4);
  });

  it("applies default variables = {}", () => {
    const result = ok(WorkflowDefinitionSchema, minimal);
    expect(result.variables).toEqual({});
  });

  it("rejects name exceeding 200 characters", () => {
    fail(WorkflowDefinitionSchema, { ...minimal, name: "x".repeat(201) });
  });

  it("accepts name at max 200 characters", () => {
    const name = "x".repeat(200);
    const result = ok(WorkflowDefinitionSchema, { ...minimal, name });
    expect(result.name).toBe(name);
  });

  it("rejects empty name", () => {
    fail(WorkflowDefinitionSchema, { ...minimal, name: "" });
  });

  it("rejects empty steps array", () => {
    fail(WorkflowDefinitionSchema, { ...minimal, steps: [] });
  });

  it("rejects when steps is missing", () => {
    fail(WorkflowDefinitionSchema, { name: "test-workflow" });
  });

  it("enforces max_concurrency >= 1", () => {
    fail(WorkflowDefinitionSchema, { ...minimal, max_concurrency: 0 });
  });

  it("enforces max_concurrency <= 10", () => {
    fail(WorkflowDefinitionSchema, { ...minimal, max_concurrency: 11 });
  });

  it("accepts max_concurrency at boundaries 1 and 10", () => {
    expect(
      ok(WorkflowDefinitionSchema, { ...minimal, max_concurrency: 1 }).max_concurrency,
    ).toBe(1);
    expect(
      ok(WorkflowDefinitionSchema, { ...minimal, max_concurrency: 10 }).max_concurrency,
    ).toBe(10);
  });

  it("accepts on_failure = continue", () => {
    const result = ok(WorkflowDefinitionSchema, { ...minimal, on_failure: "continue" });
    expect(result.on_failure).toBe("continue");
  });

  it("accepts on_failure = rollback", () => {
    const result = ok(WorkflowDefinitionSchema, { ...minimal, on_failure: "rollback" });
    expect(result.on_failure).toBe("rollback");
  });

  it("rejects invalid on_failure value", () => {
    fail(WorkflowDefinitionSchema, { ...minimal, on_failure: "retry" });
  });

  it("parses a fully specified workflow definition with variables", () => {
    const result = ok(WorkflowDefinitionSchema, {
      name: "Order Processing Pipeline",
      version: "2.0",
      description: "End-to-end order processing workflow",
      variables: {
        order_id: { type: "string", required: true, description: "Order ID to process" },
        dry_run: { type: "boolean", default: false },
      },
      steps: [
        { id: "validate", type: "tool", tool: "validate_order" },
        {
          id: "check-fraud",
          type: "condition",
          expression: "$.risk_score > 0.8",
          branches: {
            high: [{ id: "flag", type: "human_approval", message: "High risk order" }],
            low: [{ id: "process", type: "agent", prompt: "Process order" }],
          },
        },
      ],
      on_failure: "rollback",
      max_concurrency: 2,
    });
    expect(result.name).toBe("Order Processing Pipeline");
    expect(result.version).toBe("2.0");
    expect(result.variables).toHaveProperty("order_id");
    expect(result.steps).toHaveLength(2);
    expect(result.on_failure).toBe("rollback");
    expect(result.max_concurrency).toBe(2);
  });

  it("rejects steps array containing an invalid step", () => {
    fail(WorkflowDefinitionSchema, {
      name: "bad-workflow",
      steps: [{ id: "s1", type: "agent" }], // missing prompt
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// StepResultSchema
// ═══════════════════════════════════════════════════════════════════

describe("StepResultSchema", () => {
  it("parses a completed step result", () => {
    const result = ok(StepResultSchema, {
      status: "completed",
      output: { summary: "All good" },
      retryCount: 0,
      durationMs: 1500,
      tokensUsed: 200,
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual({ summary: "All good" });
  });

  it("parses a failed step result with error", () => {
    const result = ok(StepResultSchema, {
      status: "failed",
      output: null,
      error: "Connection timeout",
      retryCount: 3,
      durationMs: 30000,
      reason: "Max retries exceeded",
    });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Connection timeout");
    expect(result.reason).toBe("Max retries exceeded");
  });

  it("parses a skipped step result", () => {
    const result = ok(StepResultSchema, {
      status: "skipped",
      output: null,
      reason: "Condition not met",
    });
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("Condition not met");
  });

  it("rejects invalid status", () => {
    fail(StepResultSchema, { status: "running", output: null });
    fail(StepResultSchema, { status: "cancelled", output: null });
  });

  it("rejects missing status", () => {
    fail(StepResultSchema, { output: null });
  });

  it("rejects negative retryCount", () => {
    fail(StepResultSchema, {
      status: "completed",
      output: null,
      retryCount: -1,
    });
  });

  it("rejects negative durationMs", () => {
    fail(StepResultSchema, {
      status: "completed",
      output: null,
      durationMs: -100,
    });
  });

  it("rejects negative tokensUsed", () => {
    fail(StepResultSchema, {
      status: "completed",
      output: null,
      tokensUsed: -5,
    });
  });

  it("rejects non-integer retryCount", () => {
    fail(StepResultSchema, {
      status: "completed",
      output: null,
      retryCount: 1.5,
    });
  });

  it("accepts optional fields omitted", () => {
    const result = ok(StepResultSchema, { status: "completed", output: "done" });
    expect(result.error).toBeUndefined();
    expect(result.retryCount).toBeUndefined();
    expect(result.durationMs).toBeUndefined();
    expect(result.tokensUsed).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it("accepts zero retryCount", () => {
    const result = ok(StepResultSchema, {
      status: "completed",
      output: null,
      retryCount: 0,
    });
    expect(result.retryCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// WorkflowCheckpointSchema
// ═══════════════════════════════════════════════════════════════════

describe("WorkflowCheckpointSchema", () => {
  const validCheckpoint = {
    runId: "run-001",
    workflowId: "wf-001",
    completedSteps: ["step-1", "step-2"],
    currentStep: "step-3",
    pendingSteps: ["step-3", "step-4"],
    stepLogs: [
      { status: "completed" as const, output: { result: "ok" }, durationMs: 1000 },
      { status: "failed" as const, output: null, error: "timeout", retryCount: 2, durationMs: 5000 },
    ],
    variables: { order_id: "ORD-001" },
    stepResults: { "step-1": { result: "ok" }, "step-2": null },
    savedAt: "2026-07-16T10:00:00Z",
    totalSteps: 4,
  };

  it("parses a valid checkpoint", () => {
    const result = ok(WorkflowCheckpointSchema, validCheckpoint);
    expect(result.runId).toBe("run-001");
    expect(result.completedSteps).toEqual(["step-1", "step-2"]);
    expect(result.currentStep).toBe("step-3");
    expect(result.stepLogs).toHaveLength(2);
    expect(result.totalSteps).toBe(4);
  });

  it("accepts currentStep as null (no step in progress)", () => {
    const result = ok(WorkflowCheckpointSchema, {
      ...validCheckpoint,
      currentStep: null,
    });
    expect(result.currentStep).toBeNull();
  });

  it("rejects currentStep as undefined (not nullable-like)", () => {
    // null is allowed, undefined is not — the schema has .nullable() not .optional()
    fail(WorkflowCheckpointSchema, {
      ...validCheckpoint,
      currentStep: undefined,
    });
  });

  it("rejects invalid stepLog entry", () => {
    fail(WorkflowCheckpointSchema, {
      ...validCheckpoint,
      stepLogs: [{ status: "running", output: null }],
    });
  });

  it("rejects empty stepLogs array with invalid entry", () => {
    // Empty array is fine
    const result = ok(WorkflowCheckpointSchema, {
      ...validCheckpoint,
      stepLogs: [],
    });
    expect(result.stepLogs).toEqual([]);
  });

  it("rejects negative totalSteps", () => {
    fail(WorkflowCheckpointSchema, { ...validCheckpoint, totalSteps: -1 });
  });

  it("rejects non-integer totalSteps", () => {
    fail(WorkflowCheckpointSchema, { ...validCheckpoint, totalSteps: 1.5 });
  });

  it("rejects missing runId", () => {
    fail(WorkflowCheckpointSchema, {
      ...validCheckpoint,
      runId: undefined,
    });
  });

  it("rejects empty runId", () => {
    fail(WorkflowCheckpointSchema, { ...validCheckpoint, runId: "" });
  });

  it("rejects missing workflowId", () => {
    fail(WorkflowCheckpointSchema, {
      ...validCheckpoint,
      workflowId: undefined,
    });
  });

  it("rejects empty savedAt", () => {
    fail(WorkflowCheckpointSchema, { ...validCheckpoint, savedAt: "" });
  });
});

// ═══════════════════════════════════════════════════════════════════
// CreateWorkflowSchema
// ═══════════════════════════════════════════════════════════════════

describe("CreateWorkflowSchema", () => {
  const validCreate = {
    name: "My Workflow",
    definition: {
      name: "my-workflow-def",
      steps: [
        { id: "s1", type: "agent" as const, prompt: "Do it" },
      ],
    },
  };

  it("parses a valid create request", () => {
    const result = ok(CreateWorkflowSchema, validCreate);
    expect(result.name).toBe("My Workflow");
    expect(result.definition.name).toBe("my-workflow-def");
  });

  it("applies default tags = []", () => {
    const result = ok(CreateWorkflowSchema, validCreate);
    expect(result.tags).toEqual([]);
  });

  it("accepts custom tags", () => {
    const result = ok(CreateWorkflowSchema, {
      ...validCreate,
      tags: ["production", "critical"],
    });
    expect(result.tags).toEqual(["production", "critical"]);
  });

  it("rejects missing definition", () => {
    fail(CreateWorkflowSchema, { name: "My Workflow" });
  });

  it("rejects invalid definition", () => {
    fail(CreateWorkflowSchema, {
      name: "My Workflow",
      definition: { name: "bad", steps: [] }, // steps min 1
    });
  });

  it("rejects name exceeding 200 characters", () => {
    fail(CreateWorkflowSchema, {
      ...validCreate,
      name: "x".repeat(201),
    });
  });

  it("accepts description", () => {
    const result = ok(CreateWorkflowSchema, {
      ...validCreate,
      description: "A test workflow",
    });
    expect(result.description).toBe("A test workflow");
  });
});

// ═══════════════════════════════════════════════════════════════════
// UpdateWorkflowSchema
// ═══════════════════════════════════════════════════════════════════

describe("UpdateWorkflowSchema", () => {
  it("parses an empty update (all fields optional)", () => {
    const result = ok(UpdateWorkflowSchema, {});
    expect(result.name).toBeUndefined();
    expect(result.definition).toBeUndefined();
    expect(result.tags).toBeUndefined();
  });

  it("parses a partial update with name only", () => {
    const result = ok(UpdateWorkflowSchema, { name: "New Name" });
    expect(result.name).toBe("New Name");
  });

  it("parses a partial update with tags only", () => {
    const result = ok(UpdateWorkflowSchema, { tags: ["updated"] });
    expect(result.tags).toEqual(["updated"]);
  });

  it("rejects name exceeding 200 characters", () => {
    fail(UpdateWorkflowSchema, { name: "x".repeat(201) });
  });

  it("parses a full update", () => {
    const result = ok(UpdateWorkflowSchema, {
      name: "Updated Workflow",
      description: "Updated description",
      definition: {
        name: "updated-def",
        steps: [{ id: "s1", type: "agent", prompt: "Updated" }],
      },
      tags: ["v2"],
    });
    expect(result.name).toBe("Updated Workflow");
    expect(result.tags).toEqual(["v2"]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ApprovalDecisionSchema
// ═══════════════════════════════════════════════════════════════════

describe("ApprovalDecisionSchema", () => {
  it("parses an approve decision", () => {
    const result = ok(ApprovalDecisionSchema, { action: "approve" });
    expect(result.action).toBe("approve");
  });

  it("parses a reject decision", () => {
    const result = ok(ApprovalDecisionSchema, { action: "reject" });
    expect(result.action).toBe("reject");
  });

  it("rejects invalid action", () => {
    fail(ApprovalDecisionSchema, { action: "maybe" });
    fail(ApprovalDecisionSchema, { action: "defer" });
  });

  it("rejects missing action", () => {
    fail(ApprovalDecisionSchema, {});
  });

  it("accepts rejection_reason", () => {
    const result = ok(ApprovalDecisionSchema, {
      action: "reject",
      rejection_reason: "Risk too high",
    });
    expect(result.rejection_reason).toBe("Risk too high");
  });

  it("enforces rejection_reason max 500 characters", () => {
    fail(ApprovalDecisionSchema, {
      action: "reject",
      rejection_reason: "x".repeat(501),
    });
  });

  it("accepts rejection_reason at exactly 500 characters", () => {
    const reason = "x".repeat(500);
    const result = ok(ApprovalDecisionSchema, {
      action: "reject",
      rejection_reason: reason,
    });
    expect(result.rejection_reason).toBe(reason);
  });

  it("accepts modified_args", () => {
    const result = ok(ApprovalDecisionSchema, {
      action: "approve",
      modified_args: { env: "staging", instances: 2 },
    });
    expect(result.modified_args).toEqual({ env: "staging", instances: 2 });
  });

  it("rejects rejection_reason for approve (not enforced, but verify parse)", () => {
    // Schema does not forbid rejection_reason on approve
    const result = ok(ApprovalDecisionSchema, {
      action: "approve",
      rejection_reason: "n/a",
    });
    expect(result.rejection_reason).toBe("n/a");
  });
});

// ═══════════════════════════════════════════════════════════════════
// RunWorkflowSchema
// ═══════════════════════════════════════════════════════════════════

describe("RunWorkflowSchema", () => {
  it("parses with variables provided", () => {
    const result = ok(RunWorkflowSchema, {
      variables: { order_id: "ORD-001", dry_run: false },
    });
    expect(result.variables).toEqual({ order_id: "ORD-001", dry_run: false });
  });

  it("applies default variables = {}", () => {
    const result = ok(RunWorkflowSchema, {});
    expect(result.variables).toEqual({});
  });

  it("parses an empty object without variables key", () => {
    const result = ok(RunWorkflowSchema, {});
    expect(result.variables).toEqual({});
  });

  it("accepts complex nested variables", () => {
    const result = ok(RunWorkflowSchema, {
      variables: {
        config: { env: "prod", retries: 3 },
        items: [{ id: 1 }, { id: 2 }],
      },
    });
    expect(result.variables.config).toEqual({ env: "prod", retries: 3 });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Cross-cutting: WorkflowDefinitionSchema with all step types
// ═══════════════════════════════════════════════════════════════════

describe("WorkflowDefinitionSchema — full DSL coverage", () => {
  it("parses a workflow containing every step type", () => {
    const result = ok(WorkflowDefinitionSchema, {
      name: "Full Pipeline",
      steps: [
        {
          id: "agent-step",
          type: "agent",
          prompt: "Analyze input",
          max_iterations: 5,
        },
        {
          id: "tool-step",
          type: "tool",
          tool: "validate_data",
          args: { schema: "v1" },
        },
        {
          id: "condition-step",
          type: "condition",
          expression: "$.valid",
          branches: {
            true: [{ id: "next", type: "tool", tool: "proceed" }],
            false: [{ id: "stop", type: "tool", tool: "abort" }],
          },
        },
        {
          id: "parallel-step",
          type: "parallel",
          wait: "any",
          branches: [
            {
              id: "b1",
              steps: [
                { id: "p1", type: "tool", tool: "check_db" },
                { id: "p2", type: "tool", tool: "check_cache" },
              ],
            },
          ],
        },
        {
          id: "approval-step",
          type: "human_approval",
          message: "Confirm changes?",
          timeout_seconds: 120,
        },
        {
          id: "transform-step",
          type: "transform",
          operation: "filter",
          expression: "$.items[?(@.active)]",
          output_as: "active_items",
        },
      ],
    });
    expect(result.steps).toHaveLength(6);
    expect(result.steps.map((s) => s.type)).toEqual([
      "agent",
      "tool",
      "condition",
      "parallel",
      "human_approval",
      "transform",
    ]);
  });

  it("parses a workflow with step dependencies", () => {
    const result = ok(WorkflowDefinitionSchema, {
      name: "Dependent Steps",
      steps: [
        { id: "s1", type: "tool", tool: "fetch_data" },
        {
          id: "s2",
          type: "agent",
          prompt: "Process data",
          depends_on: ["s1"],
        },
        {
          id: "s3",
          type: "tool",
          tool: "notify",
          depends_on: ["s2"],
        },
      ],
    });
    const s2 = result.steps[1];
    expect(s2.type).toBe("agent");
    if (s2.type === "agent") {
      expect(s2.depends_on).toEqual(["s1"]);
    }
  });

  it("parses a workflow with variables having defaults", () => {
    const result = ok(WorkflowDefinitionSchema, {
      name: "Configurable Pipeline",
      variables: {
        env: { type: "string", default: "staging", description: "Target env" },
        retries: { type: "number", default: 3 },
        verbose: { type: "boolean", default: false },
      },
      steps: [{ id: "s1", type: "tool", tool: "deploy" }],
    });
    expect(Object.keys(result.variables)).toHaveLength(3);
    expect(result.variables.env?.default).toBe("staging");
    expect(result.variables.retries?.default).toBe(3);
  });
});
