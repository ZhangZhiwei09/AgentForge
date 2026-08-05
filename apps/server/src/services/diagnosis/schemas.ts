import { z } from "zod";

export const DiagnosisIntentSchema = z.enum([
  "error_code_explanation",
  "single_trace_diagnosis",
  "merchant_rate_drop",
  "integration_guidance",
  "unknown",
]);

export const DiagnosisStatusSchema = z.enum([
  "needs_clarification",
  "diagnosed",
  "unsupported",
  "failed",
]);

export const DiagnosisProductSchema = z.enum([
  "face_verify",
  "liveness",
  "ocr",
  "realname",
  "unknown",
]);

export const DiagnosisClientTypeSchema = z.enum([
  "h5",
  "app",
  "mini_program",
  "web",
  "unknown",
]);

export const DiagnosisEnvironmentSchema = z.enum([
  "prod",
  "test",
  "unknown",
]);

export const DiagnosisTimeRangeSchema = z.object({
  raw: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
});

export const DiagnosisEntitiesSchema = z.object({
  merchantId: z.string().optional(),
  appId: z.string().optional(),
  traceId: z.string().optional(),
  orderId: z.string().optional(),
  product: DiagnosisProductSchema.optional(),
  errorCode: z.string().optional(),
  clientType: DiagnosisClientTypeSchema.optional(),
  environment: DiagnosisEnvironmentSchema.optional(),
  timeRange: DiagnosisTimeRangeSchema.optional(),
});

export const DiagnosisKnowledgeEvidenceSchema = z.object({
  id: z.string(),
  source: z.literal("knowledge"),
  title: z.string(),
  content: z.string(),
  score: z.number(),
  docId: z.string().optional(),
  chunkId: z.string().optional(),
});

export const DiagnosisToolCallSchema = z.object({
  name: z.enum(["query_trace_log"]),
  reason: z.string(),
  args: z.record(z.unknown()),
});

export const DiagnosisToolResultSchema = z.object({
  toolName: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  data: z.record(z.unknown()),
});

export const DiagnosisEvidenceSchema = z.object({
  id: z.string(),
  source: z.enum(["query", "knowledge", "monitoring"]),
  title: z.string(),
  detail: z.string(),
});

export const DiagnosisResponseSchema = z.object({
  intent: DiagnosisIntentSchema,
  status: DiagnosisStatusSchema,
  entities: DiagnosisEntitiesSchema,
  missingFields: z.array(z.string()),
  evidence: z.array(DiagnosisEvidenceSchema),
  toolResults: z.array(DiagnosisToolResultSchema),
  answer: z.string(),
  warnings: z.array(z.string()),
});

export type DiagnosisIntent = z.infer<typeof DiagnosisIntentSchema>;
export type DiagnosisStatus = z.infer<typeof DiagnosisStatusSchema>;
export type DiagnosisEntities = z.infer<typeof DiagnosisEntitiesSchema>;
export type DiagnosisKnowledgeEvidence = z.infer<typeof DiagnosisKnowledgeEvidenceSchema>;
export type DiagnosisToolCall = z.infer<typeof DiagnosisToolCallSchema>;
export type DiagnosisToolResult = z.infer<typeof DiagnosisToolResultSchema>;
export type DiagnosisEvidence = z.infer<typeof DiagnosisEvidenceSchema>;
export type DiagnosisResponse = z.infer<typeof DiagnosisResponseSchema>;

