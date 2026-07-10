// Team Zod Schemas — validation for Multi-Agent Team DSL and API requests
import { z } from "zod";

// ---- Agent Role ----

export const AgentRoleSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(
      /^[a-z0-9_]+$/,
      "Agent name must be lowercase alphanumeric with underscores",
    ),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1),
  systemPrompt: z.string().min(1),
  model: z.string().optional(),
  tools: z.array(z.string()),
  maxIterations: z.number().int().min(1).max(50).default(5),
  temperature: z.number().min(0).max(2).optional(),
  priority: z.number().int().min(1).max(10).default(5),
  canDelegate: z.boolean().default(false),
  canBroadcast: z.boolean().default(false),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});

// ---- Team Definition ----

const TeamDefinitionVariableSchema = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  default: z.unknown().optional(),
  description: z.string().optional(),
});

export const TeamDefinitionSchema = z
  .object({
    name: z.string().min(1).max(200),
    version: z.string().min(1),
    description: z.string().optional(),
    collaborationMode: z.enum(["diagnosis"]),
    agents: z.array(AgentRoleSchema).min(2).max(10),
    maxTotalIterations: z.number().int().min(1).max(500).default(50),
    stopCondition: z
      .enum(["all_done", "consensus"])
      .optional(),
    timeout: z.number().int().min(10).max(3600).optional(),
    onFailure: z.enum(["stop", "continue", "retry"]).optional(),
    variables: z.record(z.string(), TeamDefinitionVariableSchema).optional(),
  })
  .refine(
    (def) => {
      // Agent names must be unique
      const names = def.agents.map((a) => a.name);
      return new Set(names).size === names.length;
    },
    { message: "Agent names must be unique", path: ["agents"] },
  );

// ---- API Request Schemas ----

export const CreateTeamSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  definition: TeamDefinitionSchema,
  tags: z.array(z.string()).optional(),
});

export const UpdateTeamSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  definition: TeamDefinitionSchema.optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
});

export const RunTeamSchema = z.object({
  task: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).optional(),
  conversationId: z.string().optional(),
});

export const ApprovalDecisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  modifiedArgs: z.record(z.string(), z.unknown()).optional(),
  rejectionReason: z.string().optional(),
});

// ---- Validation Function ----

export function validateTeamDefinition(definition: unknown): {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
} {
  const result = TeamDefinitionSchema.safeParse(definition);
  if (result.success) {
    return { valid: true };
  }
  const errors = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return { valid: false, errors };
}
