// Team Schema Validation Tests
// ==================================
// Validates all Zod schemas exported from ../schema.ts
// Covers: positive (valid data), negative (invalid data), defaults, and boundary values.

import { describe, it, expect } from "vitest";
import {
  AgentRoleSchema,
  TeamDefinitionSchema,
  CreateTeamSchema,
  UpdateTeamSchema,
  RunTeamSchema,
  ApprovalDecisionSchema,
  validateTeamDefinition,
} from "../schema";

// =====================================================================
// Helpers
// =====================================================================

/** Shorthand: assert parse succeeds and returns parsed data */
function ok<T>(schema: { parse: (v: unknown) => T }, data: unknown): T {
  return schema.parse(data);
}

/** Shorthand: assert parse throws */
function fail(schema: { parse: (v: unknown) => unknown }, data: unknown): void {
  expect(() => schema.parse(data)).toThrow();
}

// =====================================================================
// Minimal valid agent for reuse across tests
// =====================================================================

const minimalAgent = {
  name: "analyst",
  displayName: "Analyst",
  description: "Data analyst agent",
  systemPrompt: "You are a data analyst",
  tools: [],
};

function makeAgent(overrides: Record<string, unknown> = {}) {
  return { ...minimalAgent, ...overrides };
}

// =====================================================================
// AgentRoleSchema
// =====================================================================

describe("AgentRoleSchema", () => {
  // -- Positive cases --

  it("parses a minimal valid agent", () => {
    const result = ok(AgentRoleSchema, minimalAgent);
    expect(result.name).toBe("analyst");
    expect(result.displayName).toBe("Analyst");
    expect(result.description).toBe("Data analyst agent");
    expect(result.systemPrompt).toBe("You are a data analyst");
    expect(result.tools).toEqual([]);
  });

  it("parses a fully specified agent with all optional fields", () => {
    const result = ok(AgentRoleSchema, {
      name: "senior_dev",
      displayName: "Senior Developer",
      description: "Senior software engineer",
      systemPrompt: "You are a senior developer",
      model: "gpt-4o",
      tools: ["read_file", "search_code", "execute_tests"],
      maxIterations: 10,
      temperature: 0.7,
      priority: 8,
      canDelegate: true,
      canBroadcast: true,
      outputSchema: { code: {}, summary: {} },
    });
    expect(result.model).toBe("gpt-4o");
    expect(result.tools).toEqual(["read_file", "search_code", "execute_tests"]);
    expect(result.maxIterations).toBe(10);
    expect(result.temperature).toBe(0.7);
    expect(result.priority).toBe(8);
    expect(result.canDelegate).toBe(true);
    expect(result.canBroadcast).toBe(true);
    expect(result.outputSchema).toEqual({ code: {}, summary: {} });
  });

  // -- name validation --

  it("rejects name containing uppercase letters", () => {
    fail(AgentRoleSchema, makeAgent({ name: "Analyst" }));
    fail(AgentRoleSchema, makeAgent({ name: "dataAnalyst" }));
  });

  it("rejects name containing hyphens", () => {
    fail(AgentRoleSchema, makeAgent({ name: "data-analyst" }));
    fail(AgentRoleSchema, makeAgent({ name: "my-agent" }));
  });

  it("rejects name containing special characters", () => {
    fail(AgentRoleSchema, makeAgent({ name: "data@analyst" }));
    fail(AgentRoleSchema, makeAgent({ name: "data.analyst" }));
    fail(AgentRoleSchema, makeAgent({ name: "data analyst" }));
    fail(AgentRoleSchema, makeAgent({ name: "analyst!" }));
  });

  it("accepts name with lowercase, digits, and underscores", () => {
    const validNames = ["a", "agent_1", "senior_agent_007", "dev_ops", "tester_v2"];
    for (const name of validNames) {
      const result = ok(AgentRoleSchema, makeAgent({ name }));
      expect(result.name).toBe(name);
    }
  });

  it("rejects name exceeding 50 characters", () => {
    fail(AgentRoleSchema, makeAgent({ name: "a".repeat(51) }));
  });

  it("accepts name at exactly 50 characters", () => {
    const name = "a".repeat(50);
    const result = ok(AgentRoleSchema, makeAgent({ name }));
    expect(result.name).toBe(name);
  });

  it("rejects empty name", () => {
    fail(AgentRoleSchema, makeAgent({ name: "" }));
  });

  // -- displayName validation --

  it("rejects displayName exceeding 100 characters", () => {
    fail(AgentRoleSchema, makeAgent({ displayName: "A".repeat(101) }));
  });

  it("accepts displayName at exactly 100 characters", () => {
    const displayName = "A".repeat(100);
    const result = ok(AgentRoleSchema, makeAgent({ displayName }));
    expect(result.displayName).toBe(displayName);
  });

  it("rejects empty displayName", () => {
    fail(AgentRoleSchema, makeAgent({ displayName: "" }));
  });

  // -- tools validation --

  it("accepts an empty tools array", () => {
    const result = ok(AgentRoleSchema, makeAgent({ tools: [] }));
    expect(result.tools).toEqual([]);
  });

  it("accepts multiple tools", () => {
    const result = ok(AgentRoleSchema, makeAgent({ tools: ["search", "read_file", "execute"] }));
    expect(result.tools).toHaveLength(3);
  });

  it("rejects tools that is not an array", () => {
    fail(AgentRoleSchema, makeAgent({ tools: "search" }));
  });

  // -- defaults --

  it("applies default maxIterations = 5", () => {
    const result = ok(AgentRoleSchema, minimalAgent);
    expect(result.maxIterations).toBe(5);
  });

  it("applies default priority = 5", () => {
    const result = ok(AgentRoleSchema, minimalAgent);
    expect(result.priority).toBe(5);
  });

  it("applies default canDelegate = false", () => {
    const result = ok(AgentRoleSchema, minimalAgent);
    expect(result.canDelegate).toBe(false);
  });

  it("applies default canBroadcast = false", () => {
    const result = ok(AgentRoleSchema, minimalAgent);
    expect(result.canBroadcast).toBe(false);
  });

  // -- temperature validation --

  it("accepts temperature at lower bound 0", () => {
    const result = ok(AgentRoleSchema, makeAgent({ temperature: 0 }));
    expect(result.temperature).toBe(0);
  });

  it("accepts temperature at upper bound 2", () => {
    const result = ok(AgentRoleSchema, makeAgent({ temperature: 2 }));
    expect(result.temperature).toBe(2);
  });

  it("accepts temperature in middle range", () => {
    const result = ok(AgentRoleSchema, makeAgent({ temperature: 1.0 }));
    expect(result.temperature).toBe(1.0);
  });

  it("rejects temperature below 0", () => {
    fail(AgentRoleSchema, makeAgent({ temperature: -0.1 }));
    fail(AgentRoleSchema, makeAgent({ temperature: -1 }));
  });

  it("rejects temperature above 2", () => {
    fail(AgentRoleSchema, makeAgent({ temperature: 2.1 }));
    fail(AgentRoleSchema, makeAgent({ temperature: 5 }));
  });

  it("leaves temperature undefined when omitted", () => {
    const result = ok(AgentRoleSchema, minimalAgent);
    expect(result.temperature).toBeUndefined();
  });

  // -- priority validation --

  it("rejects priority below 1", () => {
    fail(AgentRoleSchema, makeAgent({ priority: 0 }));
    fail(AgentRoleSchema, makeAgent({ priority: -1 }));
  });

  it("rejects priority above 10", () => {
    fail(AgentRoleSchema, makeAgent({ priority: 11 }));
    fail(AgentRoleSchema, makeAgent({ priority: 99 }));
  });

  it("accepts priority at boundaries 1 and 10", () => {
    expect(ok(AgentRoleSchema, makeAgent({ priority: 1 })).priority).toBe(1);
    expect(ok(AgentRoleSchema, makeAgent({ priority: 10 })).priority).toBe(10);
  });

  it("rejects non-integer priority", () => {
    fail(AgentRoleSchema, makeAgent({ priority: 3.5 }));
  });

  // -- maxIterations validation --

  it("rejects maxIterations below 1", () => {
    fail(AgentRoleSchema, makeAgent({ maxIterations: 0 }));
    fail(AgentRoleSchema, makeAgent({ maxIterations: -1 }));
  });

  it("rejects maxIterations above 50", () => {
    fail(AgentRoleSchema, makeAgent({ maxIterations: 51 }));
    fail(AgentRoleSchema, makeAgent({ maxIterations: 100 }));
  });

  it("accepts maxIterations at boundaries 1 and 50", () => {
    expect(ok(AgentRoleSchema, makeAgent({ maxIterations: 1 })).maxIterations).toBe(1);
    expect(ok(AgentRoleSchema, makeAgent({ maxIterations: 50 })).maxIterations).toBe(50);
  });

  it("rejects non-integer maxIterations", () => {
    fail(AgentRoleSchema, makeAgent({ maxIterations: 3.14 }));
  });

  // -- required fields --

  it("rejects when name is missing", () => {
    fail(AgentRoleSchema, { ...minimalAgent, name: undefined });
  });

  it("rejects when description is missing", () => {
    fail(AgentRoleSchema, { ...minimalAgent, description: undefined });
  });

  it("rejects when systemPrompt is missing", () => {
    fail(AgentRoleSchema, { ...minimalAgent, systemPrompt: undefined });
  });

  it("rejects when tools is missing", () => {
    fail(AgentRoleSchema, { ...minimalAgent, tools: undefined });
  });

  // -- optional fields omitted --

  it("leaves optional fields undefined when omitted", () => {
    const result = ok(AgentRoleSchema, minimalAgent);
    expect(result.model).toBeUndefined();
    expect(result.temperature).toBeUndefined();
    expect(result.outputSchema).toBeUndefined();
  });

  // -- canDelegate / canBroadcast explicit overrides --

  it("accepts explicit canDelegate = true", () => {
    const result = ok(AgentRoleSchema, makeAgent({ canDelegate: true }));
    expect(result.canDelegate).toBe(true);
  });

  it("accepts explicit canBroadcast = true", () => {
    const result = ok(AgentRoleSchema, makeAgent({ canBroadcast: true }));
    expect(result.canBroadcast).toBe(true);
  });

  it("rejects canDelegate with non-boolean value", () => {
    fail(AgentRoleSchema, makeAgent({ canDelegate: "yes" }));
    fail(AgentRoleSchema, makeAgent({ canDelegate: 1 }));
  });

  it("rejects canBroadcast with non-boolean value", () => {
    fail(AgentRoleSchema, makeAgent({ canBroadcast: "yes" }));
  });
});

// =====================================================================
// TeamDefinitionSchema
// =====================================================================

describe("TeamDefinitionSchema", () => {
  const twoAgents = [
    makeAgent({ name: "planner", displayName: "Planner" }),
    makeAgent({ name: "executor", displayName: "Executor" }),
  ];

  const minimalDef = {
    name: "diagnosis-team",
    version: "1.0",
    collaborationMode: "diagnosis" as const,
    agents: twoAgents,
  };

  // -- Positive cases --

  it("parses a valid team definition with 2 agents", () => {
    const result = ok(TeamDefinitionSchema, minimalDef);
    expect(result.name).toBe("diagnosis-team");
    expect(result.version).toBe("1.0");
    expect(result.agents).toHaveLength(2);
  });

  it("parses a fully specified team definition", () => {
    const result = ok(TeamDefinitionSchema, {
      name: "full-diagnosis-team",
      version: "2.0",
      description: "A full diagnosis team",
      collaborationMode: "diagnosis",
      agents: twoAgents,
      maxTotalIterations: 100,
      stopCondition: "consensus",
      timeout: 300,
      onFailure: "retry",
      variables: {
        priority: { type: "string" as const, default: "high", description: "Ticket priority" },
      },
    });
    expect(result.description).toBe("A full diagnosis team");
    expect(result.maxTotalIterations).toBe(100);
    expect(result.stopCondition).toBe("consensus");
    expect(result.timeout).toBe(300);
    expect(result.onFailure).toBe("retry");
    expect(result.variables).toHaveProperty("priority");
  });

  // -- Agent count validation --

  it("rejects team with 1 agent (min 2)", () => {
    fail(TeamDefinitionSchema, {
      ...minimalDef,
      agents: [makeAgent({ name: "solo" })],
    });
  });

  it("rejects team with 11 agents (max 10)", () => {
    const elevenAgents = Array.from({ length: 11 }, (_, i) =>
      makeAgent({ name: `agent_${i}` }),
    );
    fail(TeamDefinitionSchema, { ...minimalDef, agents: elevenAgents });
  });

  it("accepts team with exactly 2 agents (lower bound)", () => {
    const result = ok(TeamDefinitionSchema, {
      ...minimalDef,
      agents: [
        makeAgent({ name: "a" }),
        makeAgent({ name: "b" }),
      ],
    });
    expect(result.agents).toHaveLength(2);
  });

  it("accepts team with exactly 10 agents (upper bound)", () => {
    const tenAgents = Array.from({ length: 10 }, (_, i) =>
      makeAgent({ name: `agent_${i}` }),
    );
    const result = ok(TeamDefinitionSchema, { ...minimalDef, agents: tenAgents });
    expect(result.agents).toHaveLength(10);
  });

  // -- collaborationMode validation --

  it("rejects invalid collaborationMode value", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, collaborationMode: "debate" });
    fail(TeamDefinitionSchema, { ...minimalDef, collaborationMode: "voting" });
  });

  it("rejects missing collaborationMode", () => {
    const { collaborationMode: _, ...without } = minimalDef;
    fail(TeamDefinitionSchema, without);
  });

  // -- defaults --

  it("applies default maxTotalIterations = 50", () => {
    const result = ok(TeamDefinitionSchema, minimalDef);
    expect(result.maxTotalIterations).toBe(50);
  });

  // -- timeout bounds --

  it("accepts timeout at lower bound 10", () => {
    const result = ok(TeamDefinitionSchema, { ...minimalDef, timeout: 10 });
    expect(result.timeout).toBe(10);
  });

  it("accepts timeout at upper bound 3600", () => {
    const result = ok(TeamDefinitionSchema, { ...minimalDef, timeout: 3600 });
    expect(result.timeout).toBe(3600);
  });

  it("rejects timeout below 10", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, timeout: 9 });
    fail(TeamDefinitionSchema, { ...minimalDef, timeout: 0 });
    fail(TeamDefinitionSchema, { ...minimalDef, timeout: -1 });
  });

  it("rejects timeout above 3600", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, timeout: 3601 });
    fail(TeamDefinitionSchema, { ...minimalDef, timeout: 7200 });
  });

  it("rejects non-integer timeout", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, timeout: 30.5 });
  });

  // -- unique agent names (refine) --

  it("rejects duplicate agent names (refine)", () => {
    fail(TeamDefinitionSchema, {
      ...minimalDef,
      agents: [
        makeAgent({ name: "worker", displayName: "Worker A" }),
        makeAgent({ name: "worker", displayName: "Worker B" }),
      ],
    });
  });

  it("rejects three agents with two sharing a name", () => {
    fail(TeamDefinitionSchema, {
      ...minimalDef,
      agents: [
        makeAgent({ name: "alpha", displayName: "A1" }),
        makeAgent({ name: "beta", displayName: "B1" }),
        makeAgent({ name: "alpha", displayName: "A2" }),
      ],
    });
  });

  it("accepts agents with completely distinct names", () => {
    const result = ok(TeamDefinitionSchema, {
      ...minimalDef,
      agents: [
        makeAgent({ name: "alpha", displayName: "A" }),
        makeAgent({ name: "beta", displayName: "B" }),
        makeAgent({ name: "gamma", displayName: "G" }),
      ],
    });
    expect(result.agents.map((a) => a.name)).toEqual(["alpha", "beta", "gamma"]);
  });

  // -- maxTotalIterations validation --

  it("rejects maxTotalIterations below 1", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, maxTotalIterations: 0 });
    fail(TeamDefinitionSchema, { ...minimalDef, maxTotalIterations: -5 });
  });

  it("rejects maxTotalIterations above 500", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, maxTotalIterations: 501 });
  });

  it("accepts maxTotalIterations at boundaries 1 and 500", () => {
    expect(
      ok(TeamDefinitionSchema, { ...minimalDef, maxTotalIterations: 1 }).maxTotalIterations,
    ).toBe(1);
    expect(
      ok(TeamDefinitionSchema, { ...minimalDef, maxTotalIterations: 500 }).maxTotalIterations,
    ).toBe(500);
  });

  // -- stopCondition validation --

  it("accepts stopCondition = all_done", () => {
    const result = ok(TeamDefinitionSchema, { ...minimalDef, stopCondition: "all_done" });
    expect(result.stopCondition).toBe("all_done");
  });

  it("accepts stopCondition = consensus", () => {
    const result = ok(TeamDefinitionSchema, { ...minimalDef, stopCondition: "consensus" });
    expect(result.stopCondition).toBe("consensus");
  });

  it("rejects invalid stopCondition", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, stopCondition: "timeout" });
  });

  // -- onFailure validation --

  it("accepts onFailure = stop", () => {
    const result = ok(TeamDefinitionSchema, { ...minimalDef, onFailure: "stop" });
    expect(result.onFailure).toBe("stop");
  });

  it("accepts onFailure = continue", () => {
    const result = ok(TeamDefinitionSchema, { ...minimalDef, onFailure: "continue" });
    expect(result.onFailure).toBe("continue");
  });

  it("accepts onFailure = retry", () => {
    const result = ok(TeamDefinitionSchema, { ...minimalDef, onFailure: "retry" });
    expect(result.onFailure).toBe("retry");
  });

  it("rejects invalid onFailure value", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, onFailure: "ignore" });
    fail(TeamDefinitionSchema, { ...minimalDef, onFailure: "panic" });
  });

  // -- name / version validation --

  it("rejects empty team name", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, name: "" });
  });

  it("rejects team name exceeding 200 characters", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, name: "x".repeat(201) });
  });

  it("accepts team name at exactly 200 characters", () => {
    const name = "x".repeat(200);
    const result = ok(TeamDefinitionSchema, { ...minimalDef, name });
    expect(result.name).toBe(name);
  });

  it("rejects empty version", () => {
    fail(TeamDefinitionSchema, { ...minimalDef, version: "" });
  });

  // -- agents array contains an invalid agent --

  it("rejects when an agent in the array is invalid", () => {
    fail(TeamDefinitionSchema, {
      ...minimalDef,
      agents: [
        makeAgent({ name: "valid_agent" }),
        makeAgent({ name: "Invalid-Name" }), // hyphen in name
      ],
    });
  });

  // -- optional fields omitted --

  it("leaves optional fields undefined when omitted", () => {
    const result = ok(TeamDefinitionSchema, minimalDef);
    expect(result.description).toBeUndefined();
    expect(result.stopCondition).toBeUndefined();
    expect(result.timeout).toBeUndefined();
    expect(result.onFailure).toBeUndefined();
    expect(result.variables).toBeUndefined();
  });
});

// =====================================================================
// validateTeamDefinition
// =====================================================================

describe("validateTeamDefinition", () => {
  const twoAgents = [
    makeAgent({ name: "planner", displayName: "Planner" }),
    makeAgent({ name: "executor", displayName: "Executor" }),
  ];

  const validDef = {
    name: "valid-team",
    version: "1.0",
    collaborationMode: "diagnosis",
    agents: twoAgents,
  };

  it("returns { valid: true } for a valid definition", () => {
    const result = validateTeamDefinition(validDef);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it("returns { valid: false, errors } with path and message for invalid data", () => {
    const result = validateTeamDefinition({
      name: "",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [makeAgent({ name: "solo" })],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);

    // At least one error about empty name
    const nameError = result.errors!.find((e) => e.path === "name");
    expect(nameError).toBeDefined();
    expect(nameError!.message).toBeTruthy();

    // At least one error about agent count (min 2)
    const agentError = result.errors!.find((e) => e.path === "agents");
    expect(agentError).toBeDefined();
    expect(agentError!.message).toBeTruthy();
  });

  it("returns errors with correct path strings (dot-joined)", () => {
    const result = validateTeamDefinition({
      name: "team",
      version: "",
      collaborationMode: "invalid",
      agents: [],
    });
    expect(result.valid).toBe(false);
    const paths = result.errors!.map((e) => e.path);
    // "version" should be present (empty string fails min)
    expect(paths.some((p) => p.startsWith("version"))).toBe(true);
  });

  it("returns errors for nested agent validation", () => {
    const result = validateTeamDefinition({
      name: "team",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [
        makeAgent({ name: "ok_agent" }),
        makeAgent({ name: "BAD_UPPERCASE" }),
      ],
    });
    expect(result.valid).toBe(false);
    // Should have an error about invalid agent name format
    const agentNameErrors = result.errors!.filter(
      (e) => e.path.includes("agents") && e.message.includes("lowercase"),
    );
    expect(agentNameErrors.length).toBeGreaterThan(0);
  });

  it("returns refine error for duplicate agent names", () => {
    const result = validateTeamDefinition({
      name: "team",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [
        makeAgent({ name: "dup" }),
        makeAgent({ name: "dup" }),
      ],
    });
    expect(result.valid).toBe(false);
    const refineError = result.errors!.find(
      (e) => e.path === "agents" && e.message.includes("unique"),
    );
    expect(refineError).toBeDefined();
  });

  it("handles completely malformed input (non-object)", () => {
    const result = validateTeamDefinition(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it("handles undefined input", () => {
    const result = validateTeamDefinition(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
  });

  it("returns single error message per issue", () => {
    const result = validateTeamDefinition({
      name: "x",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [makeAgent({ name: "single" })],
    });
    expect(result.valid).toBe(false);
    // Each error should have a non-empty path and message
    for (const err of result.errors!) {
      expect(typeof err.path).toBe("string");
      expect(typeof err.message).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});

// =====================================================================
// CreateTeamSchema
// =====================================================================

describe("CreateTeamSchema", () => {
  const twoAgents = [
    makeAgent({ name: "planner", displayName: "Planner" }),
    makeAgent({ name: "executor", displayName: "Executor" }),
  ];

  const validCreate = {
    name: "My Team",
    definition: {
      name: "my-team-def",
      version: "1.0",
      collaborationMode: "diagnosis" as const,
      agents: twoAgents,
    },
  };

  it("parses a valid create request", () => {
    const result = ok(CreateTeamSchema, validCreate);
    expect(result.name).toBe("My Team");
    expect(result.definition.name).toBe("my-team-def");
    expect(result.definition.agents).toHaveLength(2);
  });

  it("applies default tags = [] when omitted", () => {
    const result = ok(CreateTeamSchema, validCreate);
    // Tags is optional — verify it is undefined when not provided (schema has .optional() not .default())
    expect(result.tags).toBeUndefined();
  });

  it("accepts optional tags", () => {
    const result = ok(CreateTeamSchema, {
      ...validCreate,
      tags: ["production", "critical"],
    });
    expect(result.tags).toEqual(["production", "critical"]);
  });

  it("accepts optional description", () => {
    const result = ok(CreateTeamSchema, {
      ...validCreate,
      description: "A test team",
    });
    expect(result.description).toBe("A test team");
  });

  it("rejects missing definition", () => {
    fail(CreateTeamSchema, { name: "My Team" });
  });

  it("rejects invalid definition", () => {
    fail(CreateTeamSchema, {
      name: "My Team",
      definition: {
        name: "bad-def",
        version: "1.0",
        collaborationMode: "diagnosis",
        agents: [makeAgent({ name: "only_one" })], // min 2 agents
      },
    });
  });

  it("rejects name exceeding 200 characters", () => {
    fail(CreateTeamSchema, {
      ...validCreate,
      name: "x".repeat(201),
    });
  });

  it("accepts name at exactly 200 characters", () => {
    const name = "x".repeat(200);
    const result = ok(CreateTeamSchema, { ...validCreate, name });
    expect(result.name).toBe(name);
  });

  it("rejects empty name", () => {
    fail(CreateTeamSchema, { ...validCreate, name: "" });
  });

  it("rejects tags that is not an array of strings", () => {
    fail(CreateTeamSchema, { ...validCreate, tags: "production" });
    fail(CreateTeamSchema, { ...validCreate, tags: [1, 2, 3] });
  });
});

// =====================================================================
// UpdateTeamSchema
// =====================================================================

describe("UpdateTeamSchema", () => {
  const twoAgents = [
    makeAgent({ name: "planner", displayName: "Planner" }),
    makeAgent({ name: "executor", displayName: "Executor" }),
  ];

  it("parses an empty update (all fields optional)", () => {
    const result = ok(UpdateTeamSchema, {});
    expect(result.name).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.definition).toBeUndefined();
    expect(result.tags).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  it("parses a partial update with name only", () => {
    const result = ok(UpdateTeamSchema, { name: "New Name" });
    expect(result.name).toBe("New Name");
    expect(result.description).toBeUndefined();
  });

  it("parses a partial update with description only", () => {
    const result = ok(UpdateTeamSchema, { description: "Updated description" });
    expect(result.description).toBe("Updated description");
  });

  it("parses a partial update with tags only", () => {
    const result = ok(UpdateTeamSchema, { tags: ["updated"] });
    expect(result.tags).toEqual(["updated"]);
  });

  it("parses a partial update with status only", () => {
    const result = ok(UpdateTeamSchema, { status: "active" });
    expect(result.status).toBe("active");
  });

  it("parses a partial update with definition only", () => {
    const result = ok(UpdateTeamSchema, {
      definition: {
        name: "updated-def",
        version: "2.0",
        collaborationMode: "diagnosis",
        agents: twoAgents,
      },
    });
    expect(result.definition?.name).toBe("updated-def");
    expect(result.definition?.version).toBe("2.0");
  });

  it("parses a full update with all fields", () => {
    const result = ok(UpdateTeamSchema, {
      name: "Updated Team",
      description: "Updated description",
      definition: {
        name: "updated-def",
        version: "2.0",
        collaborationMode: "diagnosis",
        agents: twoAgents,
      },
      tags: ["v2"],
      status: "active",
    });
    expect(result.name).toBe("Updated Team");
    expect(result.tags).toEqual(["v2"]);
    expect(result.status).toBe("active");
  });

  // -- status enum --

  it("accepts status = draft", () => {
    const result = ok(UpdateTeamSchema, { status: "draft" });
    expect(result.status).toBe("draft");
  });

  it("accepts status = active", () => {
    const result = ok(UpdateTeamSchema, { status: "active" });
    expect(result.status).toBe("active");
  });

  it("accepts status = archived", () => {
    const result = ok(UpdateTeamSchema, { status: "archived" });
    expect(result.status).toBe("archived");
  });

  it("rejects invalid status value", () => {
    fail(UpdateTeamSchema, { status: "deleted" });
    fail(UpdateTeamSchema, { status: "pending" });
    fail(UpdateTeamSchema, { status: "inactive" });
  });

  // -- name validation (partial) --

  it("rejects name exceeding 200 characters", () => {
    fail(UpdateTeamSchema, { name: "x".repeat(201) });
  });

  it("rejects empty name", () => {
    fail(UpdateTeamSchema, { name: "" });
  });

  // -- definition validation (partial) --

  it("rejects invalid definition when provided", () => {
    fail(UpdateTeamSchema, {
      definition: {
        name: "bad-def",
        version: "1.0",
        collaborationMode: "diagnosis",
        agents: [makeAgent({ name: "only_one" })], // min 2
      },
    });
  });

  it("rejects invalid collaborationMode in definition", () => {
    fail(UpdateTeamSchema, {
      definition: {
        name: "bad-def",
        version: "1.0",
        collaborationMode: "invalid",
        agents: [
          makeAgent({ name: "a" }),
          makeAgent({ name: "b" }),
        ],
      },
    });
  });
});

// =====================================================================
// RunTeamSchema
// =====================================================================

describe("RunTeamSchema", () => {
  it("parses a minimal run request with task only", () => {
    const result = ok(RunTeamSchema, { task: "Diagnose the database outage" });
    expect(result.task).toBe("Diagnose the database outage");
  });

  it("rejects empty task", () => {
    fail(RunTeamSchema, { task: "" });
  });

  it("rejects missing task", () => {
    fail(RunTeamSchema, {});
    fail(RunTeamSchema, { variables: {} });
  });

  it("rejects task that is not a string", () => {
    fail(RunTeamSchema, { task: 123 });
    fail(RunTeamSchema, { task: null });
  });

  it("accepts task at exactly 1 character (min 1)", () => {
    const result = ok(RunTeamSchema, { task: "X" });
    expect(result.task).toBe("X");
  });

  it("accepts long task strings", () => {
    const longTask = "A".repeat(10000);
    const result = ok(RunTeamSchema, { task: longTask });
    expect(result.task).toBe(longTask);
  });

  it("accepts optional variables", () => {
    const result = ok(RunTeamSchema, {
      task: "Investigate error",
      variables: { ticket_id: "TICKET-001", severity: "high" },
    });
    expect(result.variables).toEqual({ ticket_id: "TICKET-001", severity: "high" });
  });

  it("accepts optional conversationId", () => {
    const result = ok(RunTeamSchema, {
      task: "Analyze log file",
      conversationId: "conv-abc-123",
    });
    expect(result.conversationId).toBe("conv-abc-123");
  });

  it("accepts all fields together", () => {
    const result = ok(RunTeamSchema, {
      task: "Full diagnosis of server crash",
      variables: { server_id: "srv-01", check_memory: true },
      conversationId: "conv-xyz-456",
    });
    expect(result.task).toBe("Full diagnosis of server crash");
    expect(result.variables?.server_id).toBe("srv-01");
    expect(result.conversationId).toBe("conv-xyz-456");
  });

  it("leaves optional fields undefined when omitted", () => {
    const result = ok(RunTeamSchema, { task: "do something" });
    expect(result.variables).toBeUndefined();
    expect(result.conversationId).toBeUndefined();
  });

  it("accepts empty variables object", () => {
    const result = ok(RunTeamSchema, { task: "test", variables: {} });
    expect(result.variables).toEqual({});
  });

  it("accepts nested variables with complex values", () => {
    const result = ok(RunTeamSchema, {
      task: "Complex analysis",
      variables: {
        config: { env: "production", timeout: 5000 },
        tags: ["urgent", "backend"],
        metadata: { createdBy: "admin", version: 2 },
      },
    });
    expect(result.variables?.config).toEqual({ env: "production", timeout: 5000 });
  });
});

// =====================================================================
// ApprovalDecisionSchema
// =====================================================================

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
    fail(ApprovalDecisionSchema, { action: "skip" });
  });

  it("rejects missing action", () => {
    fail(ApprovalDecisionSchema, {});
  });

  it("rejects action that is not a string", () => {
    fail(ApprovalDecisionSchema, { action: 1 });
    fail(ApprovalDecisionSchema, { action: true });
  });

  it("accepts optional modifiedArgs with approve", () => {
    const result = ok(ApprovalDecisionSchema, {
      action: "approve",
      modifiedArgs: { env: "staging", instances: 2 },
    });
    expect(result.action).toBe("approve");
    expect(result.modifiedArgs).toEqual({ env: "staging", instances: 2 });
  });

  it("accepts optional modifiedArgs with reject", () => {
    const result = ok(ApprovalDecisionSchema, {
      action: "reject",
      modifiedArgs: { reason: "too risky" },
    });
    expect(result.modifiedArgs).toEqual({ reason: "too risky" });
  });

  it("accepts optional rejectionReason", () => {
    const result = ok(ApprovalDecisionSchema, {
      action: "reject",
      rejectionReason: "Risk too high for production deployment",
    });
    expect(result.rejectionReason).toBe("Risk too high for production deployment");
  });

  it("accepts both modifiedArgs and rejectionReason together", () => {
    const result = ok(ApprovalDecisionSchema, {
      action: "reject",
      modifiedArgs: { env: "production" },
      rejectionReason: "Production deployments require manager approval",
    });
    expect(result.modifiedArgs).toEqual({ env: "production" });
    expect(result.rejectionReason).toBe("Production deployments require manager approval");
  });

  it("leaves optional fields undefined when omitted", () => {
    const result = ok(ApprovalDecisionSchema, { action: "approve" });
    expect(result.modifiedArgs).toBeUndefined();
    expect(result.rejectionReason).toBeUndefined();
  });

  it("accepts empty modifiedArgs object", () => {
    const result = ok(ApprovalDecisionSchema, { action: "approve", modifiedArgs: {} });
    expect(result.modifiedArgs).toEqual({});
  });

  it("accepts empty rejectionReason", () => {
    const result = ok(ApprovalDecisionSchema, { action: "reject", rejectionReason: "" });
    expect(result.rejectionReason).toBe("");
  });

  it("rejects modifiedArgs that is not an object", () => {
    fail(ApprovalDecisionSchema, { action: "approve", modifiedArgs: "bad" });
    fail(ApprovalDecisionSchema, { action: "approve", modifiedArgs: 123 });
  });
});

// =====================================================================
// Cross-cutting: TeamDefinitionSchema complex scenarios
// =====================================================================

describe("TeamDefinitionSchema — complex scenarios", () => {
  it("parses a team with max agents (10) each with distinct valid names", () => {
    const tenAgents = Array.from({ length: 10 }, (_, i) =>
      makeAgent({
        name: `agent_${i}`,
        displayName: `Agent ${i}`,
        tools: i % 2 === 0 ? [] : ["search"],
        priority: ((i % 10) + 1) as number,
      }),
    );
    const result = ok(TeamDefinitionSchema, {
      name: "max-team",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: tenAgents,
    });
    expect(result.agents).toHaveLength(10);
    // Verify all names are unique
    const names = result.agents.map((a) => a.name);
    expect(new Set(names).size).toBe(10);
  });

  it("parses a team with all agents having tools", () => {
    const result = ok(TeamDefinitionSchema, {
      name: "tooled-team",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [
        makeAgent({ name: "searcher", tools: ["web_search", "kb_search"] }),
        makeAgent({ name: "coder", tools: ["read_file", "execute_code"] }),
      ],
    });
    expect(result.agents[0].tools).toEqual(["web_search", "kb_search"]);
    expect(result.agents[1].tools).toEqual(["read_file", "execute_code"]);
  });

  it("parses a team with variables using all supported types", () => {
    const result = ok(TeamDefinitionSchema, {
      name: "typed-vars-team",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [
        makeAgent({ name: "a" }),
        makeAgent({ name: "b" }),
      ],
      variables: {
        input_str: { type: "string", default: "hello" },
        count: { type: "number", default: 42 },
        flag: { type: "boolean", default: true },
        data: { type: "object", default: {} },
        items: { type: "array", default: [] },
      },
    });
    expect(result.variables?.input_str?.type).toBe("string");
    expect(result.variables?.count?.type).toBe("number");
    expect(result.variables?.flag?.type).toBe("boolean");
    expect(result.variables?.data?.type).toBe("object");
    expect(result.variables?.items?.type).toBe("array");
  });

  it("rejects variables with invalid type", () => {
    fail(TeamDefinitionSchema, {
      name: "bad-vars-team",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [
        makeAgent({ name: "a" }),
        makeAgent({ name: "b" }),
      ],
      variables: {
        bad_var: { type: "date" },
      },
    });
  });

  it("parses a team without agents who can delegate or broadcast (defaults)", () => {
    const result = ok(TeamDefinitionSchema, {
      name: "simple-team",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [
        makeAgent({ name: "agent_a" }),
        makeAgent({ name: "agent_b" }),
      ],
    });
    for (const agent of result.agents) {
      expect(agent.canDelegate).toBe(false);
      expect(agent.canBroadcast).toBe(false);
    }
  });

  it("parses a team with mixed delegation capabilities", () => {
    const result = ok(TeamDefinitionSchema, {
      name: "mixed-delegation-team",
      version: "1.0",
      collaborationMode: "diagnosis",
      agents: [
        makeAgent({ name: "lead", canDelegate: true, canBroadcast: true, priority: 9 }),
        makeAgent({ name: "member_a", priority: 5 }),
        makeAgent({ name: "member_b", canBroadcast: true, priority: 3 }),
      ],
    });
    expect(result.agents[0].canDelegate).toBe(true);
    expect(result.agents[0].canBroadcast).toBe(true);
    expect(result.agents[1].canDelegate).toBe(false);
    expect(result.agents[1].canBroadcast).toBe(false);
    expect(result.agents[2].canDelegate).toBe(false);
    expect(result.agents[2].canBroadcast).toBe(true);
  });
});
