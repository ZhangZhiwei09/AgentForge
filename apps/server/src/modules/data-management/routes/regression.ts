import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { prisma } from "../../../db.js";
import { createHono } from "../../../lib/hono.js";
import { KnowledgeRegressionService } from "../../../services/knowledge-regression.js";

export const knowledgeRegressionRoutes = createHono();

const searchMethodSchema = z.enum(["hybrid", "semantic", "keyword"]);

const createTestSetSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
});

const regressionCaseSchema = z.object({
  testSetId: z.string().min(1).optional(),
  name: z.string().min(1).max(255),
  query: z.string().min(1).max(1000),
  expectedDocTitles: z.array(z.string().min(1)).default([]).optional(),
  expectedDocIds: z.array(z.string().min(1)).default([]).optional(),
  requiredText: z.array(z.string().min(1)).default([]).optional(),
  forbiddenText: z.array(z.string().min(1)).default([]).optional(),
  expectedTopK: z.number().int().min(1).max(20).default(5).optional(),
  minScore: z.number().min(0).max(1).nullable().optional(),
  retrievalConfig: z.object({
    searchMethod: searchMethodSchema.default("hybrid").optional(),
    topK: z.number().int().min(1).max(20).default(10).optional(),
    rerankingEnable: z.boolean().default(true).optional(),
    scoreThreshold: z.number().min(0).max(1).default(0).optional(),
  }).default({}).optional(),
  promptRequiredContextText: z.array(z.string().min(1)).default([]).optional(),
});

const runSchema = z.object({
  testSetId: z.string().min(1).optional(),
});

async function requireKnowledgeBase(kbId: string) {
  return prisma.knowledgeBase.findUnique({
    where: { id: kbId },
    select: { id: true },
  });
}

knowledgeRegressionRoutes.get(
  "/api/knowledge/bases/:kbId/regression/test-sets",
  async (c) => {
    const kbId = c.req.param("kbId");
    const kb = await requireKnowledgeBase(kbId);
    if (!kb) return c.json({ detail: "知识库不存在" }, 404);

    const service = new KnowledgeRegressionService();
    const sets = await service.listTestSets(kbId);
    if (sets.length === 0) {
      const defaultSet = await service.getOrCreateDefaultTestSet(kbId);
      return c.json([defaultSet]);
    }
    return c.json(sets);
  },
);

knowledgeRegressionRoutes.post(
  "/api/knowledge/bases/:kbId/regression/test-sets",
  zValidator("json", createTestSetSchema),
  async (c) => {
    const kbId = c.req.param("kbId");
    const kb = await requireKnowledgeBase(kbId);
    if (!kb) return c.json({ detail: "知识库不存在" }, 404);

    const service = new KnowledgeRegressionService();
    const testSet = await service.createTestSet(kbId, c.req.valid("json"));
    return c.json(testSet, 201);
  },
);

knowledgeRegressionRoutes.post(
  "/api/knowledge/bases/:kbId/regression/cases",
  zValidator("json", regressionCaseSchema),
  async (c) => {
    const kbId = c.req.param("kbId");
    const kb = await requireKnowledgeBase(kbId);
    if (!kb) return c.json({ detail: "知识库不存在" }, 404);

    const service = new KnowledgeRegressionService();
    const testCase = await service.createCase(kbId, c.req.valid("json"));
    return c.json(testCase, 201);
  },
);

knowledgeRegressionRoutes.put(
  "/api/knowledge/regression/cases/:caseId",
  zValidator("json", regressionCaseSchema),
  async (c) => {
    const caseId = c.req.param("caseId");
    const service = new KnowledgeRegressionService();
    const testCase = await service.updateCase(caseId, c.req.valid("json"));
    if (!testCase) return c.json({ detail: "回归用例不存在" }, 404);
    return c.json(testCase);
  },
);

knowledgeRegressionRoutes.delete(
  "/api/knowledge/regression/cases/:caseId",
  async (c) => {
    const caseId = c.req.param("caseId");
    const service = new KnowledgeRegressionService();
    const deleted = await service.deleteCase(caseId);
    if (!deleted) return c.json({ detail: "回归用例不存在" }, 404);
    return c.json({ status: "deleted" });
  },
);

knowledgeRegressionRoutes.post(
  "/api/knowledge/bases/:kbId/regression/runs",
  zValidator("json", runSchema),
  async (c) => {
    const kbId = c.req.param("kbId");
    const kb = await requireKnowledgeBase(kbId);
    if (!kb) return c.json({ detail: "知识库不存在" }, 404);

    const service = new KnowledgeRegressionService();
    const run = await service.runTestSet(kbId, c.req.valid("json").testSetId);
    return c.json(run, 201);
  },
);

knowledgeRegressionRoutes.get(
  "/api/knowledge/bases/:kbId/regression/runs",
  async (c) => {
    const kbId = c.req.param("kbId");
    const kb = await requireKnowledgeBase(kbId);
    if (!kb) return c.json({ detail: "知识库不存在" }, 404);

    const service = new KnowledgeRegressionService();
    const runs = await service.listRuns(kbId, c.req.query("testSetId") || undefined);
    return c.json(runs);
  },
);

const metricsQuerySchema = z.object({
  testSetId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30).optional(),
});

knowledgeRegressionRoutes.get(
  "/api/knowledge/bases/:kbId/regression/metrics",
  zValidator("query", metricsQuerySchema),
  async (c) => {
    const kbId = c.req.param("kbId");
    const kb = await requireKnowledgeBase(kbId);
    if (!kb) return c.json({ detail: "知识库不存在" }, 404);

    const { testSetId, limit } = c.req.valid("query");
    const service = new KnowledgeRegressionService();
    const metrics = await service.getRegressionMetrics(kbId, testSetId, limit);
    return c.json(metrics);
  },
);
