// 知识库管理路由 —— /api/knowledge/* 完整 CRUD + 搜索 + 统计
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { KnowledgeService } from "../services/knowledge.js";
import { KnowledgeIngestionService } from "../services/knowledge-ingestion.js";
import { logger } from "@agentforge/logger";
import { createHono } from "../lib/hono.js";

export const knowledgeRoutes = createHono();

// ════════════════════════════════════════════════════════════════
// 知识库 CRUD
// ════════════════════════════════════════════════════════════════

const kbCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
});

const kbUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

// POST /api/knowledge/bases —— 创建知识库
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

// GET /api/knowledge/bases —— 列出所有知识库（含文档计数）
knowledgeRoutes.get("/api/knowledge/bases", async (c) => {
  const bases = await prisma.knowledgeBase.findMany({
    orderBy: { createdAt: "desc" },
  });

  // 为每个知识库统计文档数
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

// GET /api/knowledge/bases/:kbId —— 获取单个知识库详情
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

// PUT /api/knowledge/bases/:kbId —— 更新知识库信息
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

// DELETE /api/knowledge/bases/:kbId —— 删除知识库
knowledgeRoutes.delete("/api/knowledge/bases/:kbId", async (c) => {
  const kbId = c.req.param("kbId");
  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });

  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  await prisma.knowledgeBase.delete({ where: { id: kbId } });

  return c.json({ status: "deleted" });
});

// ════════════════════════════════════════════════════════════════
// 文档 CRUD + 摄取
// ════════════════════════════════════════════════════════════════

const docCreateSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
});

const batchDocCreateSchema = z.object({
  documents: z.array(docCreateSchema).min(1).max(100), // 单次最多 100 篇
});

// GET /api/knowledge/bases/:kbId/documents —— 列出知识库中的所有文档
knowledgeRoutes.get("/api/knowledge/bases/:kbId/documents", async (c) => {
  const kbId = c.req.param("kbId");

  const docs = await prisma.knowledgeDocument.findMany({
    where: { knowledgeBaseId: kbId },
    orderBy: { createdAt: "desc" },
  });

  return c.json(docs);
});

// GET /api/knowledge/documents/:docId —— 获取单个文档详情
knowledgeRoutes.get("/api/knowledge/documents/:docId", async (c) => {
  const docId = c.req.param("docId");
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: docId } });

  if (!doc) {
    return c.json({ detail: "文档不存在" }, 404);
  }

  return c.json(doc);
});

// POST /api/knowledge/bases/:kbId/documents —— 上传并摄取单篇文档
// 流程：创建 PG 记录 → 切分 → embedding → 写入 Milvus → 更新 PG 状态
knowledgeRoutes.post("/api/knowledge/bases/:kbId/documents", zValidator("json", docCreateSchema), async (c) => {
  const kbId = c.req.param("kbId");
  const { title, content } = c.req.valid("json");

  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  // P1-1: 预创建文档（status: pending），投递异步 ingestion job
  const doc = await prisma.knowledgeDocument.create({
    data: {
      id: randomUUID(),
      knowledgeBaseId: kbId,
      title,
      content,
      chunkCount: 0,
      status: "pending",
    },
  });

  const { getIngestionQueue } = await import("../jobs/queues.js");
  const queue = getIngestionQueue();
  if (queue) {
    await queue.add("ingest", { docId: doc.id, kbId });
    logger.info({ docId: doc.id, title }, "Ingestion job dispatched");
  } else {
    // 优雅降级：Redis 不可用，回退同步摄取
    const ingestion = new KnowledgeIngestionService();
    await ingestion.processExistingDocument(doc.id, kbId);
  }

  const updatedDoc = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } });
  return c.json(updatedDoc, 201);
});

// POST /api/knowledge/bases/:kbId/documents/batch —— 批量上传文档 (P1-1 async)
knowledgeRoutes.post("/api/knowledge/bases/:kbId/documents/batch", zValidator("json", batchDocCreateSchema), async (c) => {
  const kbId = c.req.param("kbId");
  const { documents } = c.req.valid("json");

  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  // P1-1: 预创建文档（status: pending），逐文档投递异步 ingestion job
  const { getIngestionQueue } = await import("../jobs/queues.js");
  const queue = getIngestionQueue();
  const docIds: string[] = [];

  for (const d of documents) {
    const doc = await prisma.knowledgeDocument.create({
      data: {
        id: randomUUID(),
        knowledgeBaseId: kbId,
        title: d.title,
        content: d.content,
        chunkCount: 0,
        status: "pending",
      },
    });
    docIds.push(doc.id);

    if (queue) {
      await queue.add("ingest", { docId: doc.id, kbId });
    } else {
      // 优雅降级：同步摄取
      const ingestion = new KnowledgeIngestionService();
      await ingestion.processExistingDocument(doc.id, kbId);
    }
  }

  return c.json({
    kb_id: kbId,
    doc_ids: docIds,
    status: queue ? "pending" : "completed",
    message: `成功接收 ${docIds.length} 篇文档${queue ? "，正在后台处理" : ""}`,
  });
});

// POST /api/knowledge/bases/:kbId/documents/upload —— 上传文件并自动摄取
// 支持格式：.txt, .md, .json, .csv, .html, .xml, .yaml, .yml
// Content-Type: multipart/form-data，字段名：file
knowledgeRoutes.post("/api/knowledge/bases/:kbId/documents/upload", async (c) => {
  const kbId = c.req.param("kbId");

  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  try {
    const body = await c.req.parseBody();
    const file = body["file"] as File | undefined;

    if (!file || !(file instanceof File)) {
      return c.json({ detail: "请上传文件（字段名：file）" }, 400);
    }

    // 获取文件名和扩展名
    const fileName = file.name || "uploaded_file";
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    const supportedExts = ["txt", "md", "json", "csv", "html", "xml", "yaml", "yml", "log"];

    if (!supportedExts.includes(ext)) {
      return c.json({
        detail: `不支持的文件类型 .${ext}。支持的格式：${supportedExts.join(", ")}`,
      }, 400);
    }

    // 限制文件大小（10MB）
    const MAX_SIZE = 10 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      return c.json({
        detail: `文件过大（${(file.size / 1024 / 1024).toFixed(2)}MB），最大支持 10MB`,
      }, 400);
    }

    // 读取文件内容为文本
    const content = await file.text();
    if (!content.trim()) {
      return c.json({ detail: "文件内容为空" }, 400);
    }

    // 使用文件名（去掉扩展名）作为文档标题
    const title = fileName.replace(/\.[^/.]+$/, "");

    // P1-1: 预创建文档（status: pending），投递异步 ingestion job
    const doc = await prisma.knowledgeDocument.create({
      data: {
        id: randomUUID(),
        knowledgeBaseId: kbId,
        title,
        content,
        chunkCount: 0,
        status: "pending",
      },
    });

    const { getIngestionQueue } = await import("../jobs/queues.js");
    const queue = getIngestionQueue();
    if (queue) {
      await queue.add("ingest", { docId: doc.id, kbId });
      logger.info({ docId: doc.id, title }, "Ingestion job dispatched");
    } else {
      const ingestion = new KnowledgeIngestionService();
      await ingestion.processExistingDocument(doc.id, kbId);
    }

    const updatedDoc = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } });
    return c.json({
      ...updatedDoc,
      file_name: fileName,
      file_size: file.size,
    }, 201);
  } catch (e) {
    logger.error(e, "File upload failed");
    return c.json({
      detail: e instanceof Error ? e.message : "文件上传处理失败",
    }, 500);
  }
});

// DELETE /api/knowledge/documents/:docId —— 删除文档（PG + Milvus 双删）
knowledgeRoutes.delete("/api/knowledge/documents/:docId", async (c) => {
  const docId = c.req.param("docId");
  const ingestion = new KnowledgeIngestionService();
  const deleted = await ingestion.deleteDocument(docId);

  if (!deleted) {
    return c.json({ detail: "文档不存在" }, 404);
  }

  return c.json({ status: "deleted" });
});

// ════════════════════════════════════════════════════════════════
// Chunk 查询
// ════════════════════════════════════════════════════════════════

// GET /api/knowledge/documents/:docId/chunks —— 查看文档的所有切片
knowledgeRoutes.get("/api/knowledge/documents/:docId/chunks", async (c) => {
  const docId = c.req.param("docId");

  const chunks = await prisma.knowledgeChunk.findMany({
    where: { documentId: docId },
    orderBy: { chunkIndex: "asc" },
  });

  return c.json(chunks);
});

// ════════════════════════════════════════════════════════════════
// 搜索
// ════════════════════════════════════════════════════════════════

const searchSchema = z.object({
  query: z.string().min(1),
  kb_ids: z.array(z.string()).nullable().optional(), // 可选：限定知识库范围
  top_k: z.number().int().min(1).max(20).default(3),
});

// POST /api/knowledge/search —— 知识库语义搜索
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

// ════════════════════════════════════════════════════════════════
// 统计
// ════════════════════════════════════════════════════════════════

// GET /api/knowledge/stats —— 获取知识库整体统计
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
