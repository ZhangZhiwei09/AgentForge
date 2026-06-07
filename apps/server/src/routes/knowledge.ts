import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { KnowledgeService } from "../services/knowledge.js";
import { KnowledgeIngestionService } from "../services/knowledge-ingestion.js";

export const knowledgeRoutes = new Hono();

// ── Knowledge Base CRUD ────────────────────────────────────────

const kbCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
});

const kbUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

// POST /api/knowledge/bases
knowledgeRoutes.post("/api/knowledge/bases", zValidator("json", kbCreateSchema), async (c) => {
  const { name, description } = c.req.valid("json");

  const kb = await prisma.knowledgeBase.create({
    data: { id: randomUUID(), name, description },
  });

  return c.json({
    id: kb.id,
    name: kb.name,
    description: kb.description,
    enabled: kb.enabled,
    document_count: 0,
    created_at: kb.createdAt,
    updated_at: kb.updatedAt,
  }, 201);
});

// GET /api/knowledge/bases
knowledgeRoutes.get("/api/knowledge/bases", async (c) => {
  const bases = await prisma.knowledgeBase.findMany({
    orderBy: { createdAt: "desc" },
  });

  const responses = await Promise.all(
    bases.map(async (kb) => {
      const docCount = await prisma.knowledgeDocument.count({
        where: { knowledgeBaseId: kb.id },
      });
      return {
        id: kb.id,
        name: kb.name,
        description: kb.description,
        enabled: kb.enabled,
        document_count: docCount,
        created_at: kb.createdAt,
        updated_at: kb.updatedAt,
      };
    }),
  );

  return c.json(responses);
});

// GET /api/knowledge/bases/:kbId
knowledgeRoutes.get("/api/knowledge/bases/:kbId", async (c) => {
  const kbId = c.req.param("kbId");
  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });

  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  const docCount = await prisma.knowledgeDocument.count({
    where: { knowledgeBaseId: kb.id },
  });

  return c.json({
    id: kb.id,
    name: kb.name,
    description: kb.description,
    enabled: kb.enabled,
    document_count: docCount,
    created_at: kb.createdAt,
    updated_at: kb.updatedAt,
  });
});

// PUT /api/knowledge/bases/:kbId
knowledgeRoutes.put("/api/knowledge/bases/:kbId", zValidator("json", kbUpdateSchema), async (c) => {
  const kbId = c.req.param("kbId");
  const data = c.req.valid("json");

  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  const updateData: { name?: string; description?: string | null; enabled?: boolean } = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.enabled !== undefined) updateData.enabled = data.enabled;

  const updated = await prisma.knowledgeBase.update({
    where: { id: kbId },
    data: updateData,
  });

  const docCount = await prisma.knowledgeDocument.count({
    where: { knowledgeBaseId: kb.id },
  });

  return c.json({
    id: updated.id,
    name: updated.name,
    description: updated.description,
    enabled: updated.enabled,
    document_count: docCount,
    created_at: updated.createdAt,
    updated_at: updated.updatedAt,
  });
});

// DELETE /api/knowledge/bases/:kbId
knowledgeRoutes.delete("/api/knowledge/bases/:kbId", async (c) => {
  const kbId = c.req.param("kbId");
  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });

  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  await prisma.knowledgeBase.delete({ where: { id: kbId } });

  return c.json({ status: "deleted" });
});

// ── Document CRUD ──────────────────────────────────────────────

const docCreateSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
});

const batchDocCreateSchema = z.object({
  documents: z.array(docCreateSchema).min(1).max(100),
});

// GET /api/knowledge/bases/:kbId/documents
knowledgeRoutes.get("/api/knowledge/bases/:kbId/documents", async (c) => {
  const kbId = c.req.param("kbId");

  const docs = await prisma.knowledgeDocument.findMany({
    where: { knowledgeBaseId: kbId },
    orderBy: { createdAt: "desc" },
  });

  return c.json(docs);
});

// GET /api/knowledge/documents/:docId
knowledgeRoutes.get("/api/knowledge/documents/:docId", async (c) => {
  const docId = c.req.param("docId");
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: docId } });

  if (!doc) {
    return c.json({ detail: "文档不存在" }, 404);
  }

  return c.json(doc);
});

// POST /api/knowledge/bases/:kbId/documents
knowledgeRoutes.post("/api/knowledge/bases/:kbId/documents", zValidator("json", docCreateSchema), async (c) => {
  const kbId = c.req.param("kbId");
  const { title, content } = c.req.valid("json");

  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  const ingestion = new KnowledgeIngestionService();
  const doc = await ingestion.ingestDocument(kbId, title, content);

  return c.json(doc, 201);
});

// POST /api/knowledge/bases/:kbId/documents/batch
knowledgeRoutes.post("/api/knowledge/bases/:kbId/documents/batch", zValidator("json", batchDocCreateSchema), async (c) => {
  const kbId = c.req.param("kbId");
  const { documents } = c.req.valid("json");

  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  const ingestion = new KnowledgeIngestionService();
  const docsData = documents.map((d) => ({ title: d.title, content: d.content }));
  const docs = await ingestion.batchIngest(kbId, docsData);

  return c.json({
    kb_id: kbId,
    doc_ids: docs.filter((d): d is NonNullable<typeof d> => d !== null).map((d) => d.id),
    status: "completed",
    message: `成功摄入 ${docs.length} 篇文档`,
  });
});

// DELETE /api/knowledge/documents/:docId
knowledgeRoutes.delete("/api/knowledge/documents/:docId", async (c) => {
  const docId = c.req.param("docId");
  const ingestion = new KnowledgeIngestionService();
  const deleted = await ingestion.deleteDocument(docId);

  if (!deleted) {
    return c.json({ detail: "文档不存在" }, 404);
  }

  return c.json({ status: "deleted" });
});

// ── Chunk Query ────────────────────────────────────────────────

// GET /api/knowledge/documents/:docId/chunks
knowledgeRoutes.get("/api/knowledge/documents/:docId/chunks", async (c) => {
  const docId = c.req.param("docId");

  const chunks = await prisma.knowledgeChunk.findMany({
    where: { documentId: docId },
    orderBy: { chunkIndex: "asc" },
  });

  return c.json(chunks);
});

// ── Search ──────────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1),
  kb_ids: z.array(z.string()).nullable().optional(),
  top_k: z.number().int().min(1).max(20).default(3),
});

// POST /api/knowledge/search
knowledgeRoutes.post("/api/knowledge/search", zValidator("json", searchSchema), async (c) => {
  const { query, kb_ids, top_k } = c.req.valid("json");

  const service = new KnowledgeService();
  const results = await service.search(query, kb_ids, top_k);

  return c.json({
    results,
    query,
    total: results.length,
  });
});

// ── Stats ────────────────────────────────────────────────────────

// GET /api/knowledge/stats
knowledgeRoutes.get("/api/knowledge/stats", async (c) => {
  const service = new KnowledgeService();
  const milvusStats = await service.getCollectionStats();

  const kbCount = await prisma.knowledgeBase.count();
  const docCount = await prisma.knowledgeDocument.count();
  const chunkCount = await prisma.knowledgeChunk.count();

  return c.json({
    knowledge_bases: kbCount,
    documents: docCount,
    chunks: chunkCount,
    milvus: milvusStats,
  });
});
