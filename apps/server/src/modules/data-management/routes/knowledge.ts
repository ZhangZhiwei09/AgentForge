// 知识库管理路由 —— /api/knowledge/* 完整 CRUD + 搜索 + 统计
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../../../db.js";
import { KnowledgeService } from "../../../services/knowledge.js";
import { KnowledgeIngestionService } from "../../../services/knowledge-ingestion.js";
import { getParserRegistry } from "../../../services/document-parser/index.js";
import { getStorageProvider } from "../../../services/storage/index.js";
import { logger } from "@agentforge/logger";
import { createHono } from "../../../lib/hono.js";

export const knowledgeManagementRoutes = createHono();

// 安全解析 JSON 字符串，失败时返回原始字符串
function safeJsonParse(v: string | null | undefined): unknown {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

// ════════════════════════════════════════════════════════════════
// 知识库 CRUD
// ════════════════════════════════════════════════════════════════

const kbCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  chunk_size_tokens: z
    .number()
    .int()
    .min(200)
    .max(2000)
    .optional(),
  chunk_overlap_tokens: z
    .number()
    .int()
    .min(0)
    .optional(),
}).superRefine((data, ctx) => {
  // 校验：overlap < size * 0.5
  const size = data.chunk_size_tokens;
  const overlap = data.chunk_overlap_tokens;
  if (size !== undefined && overlap !== undefined && overlap >= size * 0.5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "chunk_overlap_tokens must be less than chunk_size_tokens * 0.5",
      path: ["chunk_overlap_tokens"],
    });
  }
  // 校验：overlap < size（基础约束）
  if (size !== undefined && overlap !== undefined && overlap >= size) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "chunk_overlap_tokens must be less than chunk_size_tokens",
      path: ["chunk_overlap_tokens"],
    });
  }
});

const kbUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  chunk_size_tokens: z
    .number()
    .int()
    .min(200)
    .max(2000)
    .optional(),
  chunk_overlap_tokens: z
    .number()
    .int()
    .min(0)
    .optional(),
}).superRefine((data, ctx) => {
  const size = data.chunk_size_tokens;
  const overlap = data.chunk_overlap_tokens;
  if (size !== undefined && overlap !== undefined && overlap >= size * 0.5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "chunk_overlap_tokens must be less than chunk_size_tokens * 0.5",
      path: ["chunk_overlap_tokens"],
    });
  }
  if (size !== undefined && overlap !== undefined && overlap >= size) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "chunk_overlap_tokens must be less than chunk_size_tokens",
      path: ["chunk_overlap_tokens"],
    });
  }
});

// POST /api/knowledge/bases —— 创建知识库
knowledgeManagementRoutes.post(
  "/api/knowledge/bases",
  zValidator("json", kbCreateSchema),
  async (c) => {
    const { name, description, chunk_size_tokens, chunk_overlap_tokens } =
      c.req.valid("json");

    const kb = await prisma.knowledgeBase.create({
      data: {
        id: randomUUID(),
        name,
        description,
        chunkSizeTokens: chunk_size_tokens,
        chunkOverlapTokens: chunk_overlap_tokens,
      },
    });

    return c.json(
      {
        id: kb.id,
        name: kb.name,
        description: kb.description,
        enabled: kb.enabled,
        chunk_size_tokens: kb.chunkSizeTokens,
        chunk_overlap_tokens: kb.chunkOverlapTokens,
        document_count: 0,
        created_at: kb.createdAt,
        updated_at: kb.updatedAt,
      },
      201,
    );
  },
);

// GET /api/knowledge/bases —— 列出所有知识库（含文档计数）
knowledgeManagementRoutes.get("/api/knowledge/bases", async (c) => {
  const bases = await prisma.knowledgeBase.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { documents: true } },
    },
  });

  const responses = bases.map((kb) => ({
    id: kb.id,
    name: kb.name,
    description: kb.description,
    enabled: kb.enabled,
    chunk_size_tokens: kb.chunkSizeTokens,
    chunk_overlap_tokens: kb.chunkOverlapTokens,
    document_count: kb._count.documents,
    created_at: kb.createdAt,
    updated_at: kb.updatedAt,
  }));

  return c.json(responses);
});

// GET /api/knowledge/bases/:kbId —— 获取单个知识库详情
knowledgeManagementRoutes.get("/api/knowledge/bases/:kbId", async (c) => {
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
    chunk_size_tokens: kb.chunkSizeTokens,
    chunk_overlap_tokens: kb.chunkOverlapTokens,
    document_count: docCount,
    created_at: kb.createdAt,
    updated_at: kb.updatedAt,
  });
});

// PUT /api/knowledge/bases/:kbId —— 更新知识库信息
knowledgeManagementRoutes.put(
  "/api/knowledge/bases/:kbId",
  zValidator("json", kbUpdateSchema),
  async (c) => {
    const kbId = c.req.param("kbId");
    const data = c.req.valid("json");

    const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
    if (!kb) {
      return c.json({ detail: "知识库不存在" }, 404);
    }

    const updateData: {
      name?: string;
      description?: string | null;
      enabled?: boolean;
      chunkSizeTokens?: number | null;
      chunkOverlapTokens?: number | null;
    } = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.chunk_size_tokens !== undefined)
      updateData.chunkSizeTokens = data.chunk_size_tokens;
    if (data.chunk_overlap_tokens !== undefined)
      updateData.chunkOverlapTokens = data.chunk_overlap_tokens;

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
      chunk_size_tokens: updated.chunkSizeTokens,
      chunk_overlap_tokens: updated.chunkOverlapTokens,
      document_count: docCount,
      created_at: updated.createdAt,
      updated_at: updated.updatedAt,
    });
  },
);

// DELETE /api/knowledge/bases/:kbId —— 删除知识库
knowledgeManagementRoutes.delete("/api/knowledge/bases/:kbId", async (c) => {
  const kbId = c.req.param("kbId");
  const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });

  if (!kb) {
    return c.json({ detail: "知识库不存在" }, 404);
  }

  // 按 FK 依赖顺序删除：chunks → documents → knowledge_base
  // KnowledgeInvertedIndex 有 ON DELETE CASCADE，会随 chunk/kb 自动删除
  await prisma.$transaction(async (tx) => {
    await tx.knowledgeChunk.deleteMany({ where: { knowledgeBaseId: kbId } });
    await tx.knowledgeDocument.deleteMany({ where: { knowledgeBaseId: kbId } });
    await tx.knowledgeBase.delete({ where: { id: kbId } });
  });

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
  documents: z.array(docCreateSchema).min(1).max(100),
});

// GET /api/knowledge/bases/:kbId/documents —— 列出知识库中的所有文档
// 不返回 content（可能很大），返回阶段时间戳与进度信息
knowledgeManagementRoutes.get("/api/knowledge/bases/:kbId/documents", async (c) => {
  const kbId = c.req.param("kbId");

  const docs = await prisma.knowledgeDocument.findMany({
    where: { knowledgeBaseId: kbId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      knowledgeBaseId: true,
      title: true,
      chunkCount: true,
      status: true,
      enabled: true,
      createdAt: true,
      updatedAt: true,
      originalFilename: true,
      originalFileType: true,
      originalFileSize: true,
      errorMessage: true,
      retryCount: true,
      qualityLabel: true,
      processingDetail: true,
      processingStartedAt: true,
      downloadingCompletedAt: true,
      parsingCompletedAt: true,
      normalizingCompletedAt: true,
      chunkingCompletedAt: true,
      embeddingCompletedAt: true,
    },
  });

  // 解析 processingDetail JSON 字符串为对象，方便前端使用
  const parsed = docs.map((d) => ({
    ...d,
    processingDetail: d.processingDetail ? safeJsonParse(d.processingDetail) : null,
  }));

  return c.json(parsed);
});

// GET /api/knowledge/documents/:docId —— 获取单个文档详情（含完整内容、阶段时间戳、进度信息）
knowledgeManagementRoutes.get("/api/knowledge/documents/:docId", async (c) => {
  const docId = c.req.param("docId");
  const doc = await prisma.knowledgeDocument.findUnique({
    where: { id: docId },
  });

  if (!doc) {
    return c.json({ detail: "文档不存在" }, 404);
  }

  // 解析 processingDetail JSON 字符串为对象
  return c.json({
    ...doc,
    processingDetail: doc.processingDetail ? safeJsonParse(doc.processingDetail) : null,
  });
});

// POST /api/knowledge/bases/:kbId/documents —— 上传并摄取单篇文档
knowledgeManagementRoutes.post(
  "/api/knowledge/bases/:kbId/documents",
  zValidator("json", docCreateSchema),
  async (c) => {
    const kbId = c.req.param("kbId");
    const { title, content } = c.req.valid("json");

    const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
    if (!kb) {
      return c.json({ detail: "知识库不存在" }, 404);
    }

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

    const { getIngestionQueue } = await import("../../../jobs/queues.js");
    const queue = getIngestionQueue();
    if (queue) {
      await queue.add("ingest", { docId: doc.id, kbId });
      logger.info({ docId: doc.id, title }, "Ingestion job dispatched");
    } else {
      const ingestion = new KnowledgeIngestionService();
      await ingestion.processExistingDocument(doc.id, kbId);
    }

    const updatedDoc = await prisma.knowledgeDocument.findUnique({
      where: { id: doc.id },
    });
    return c.json(updatedDoc, 201);
  },
);

// POST /api/knowledge/bases/:kbId/documents/batch —— 批量上传文档
knowledgeManagementRoutes.post(
  "/api/knowledge/bases/:kbId/documents/batch",
  zValidator("json", batchDocCreateSchema),
  async (c) => {
    const kbId = c.req.param("kbId");
    const { documents } = c.req.valid("json");

    const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
    if (!kb) {
      return c.json({ detail: "知识库不存在" }, 404);
    }

    const { getIngestionQueue } = await import("../../../jobs/queues.js");
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
  },
);

// POST /api/knowledge/bases/:kbId/documents/upload —— V2.2: 上传文件并异步摄取
// API 极薄：保存文件 → 创建文档(PENDING) → 入队 → 返回 documentId
// 解析/清洗/质量判断全在 Worker 中完成
knowledgeManagementRoutes.post(
  "/api/knowledge/bases/:kbId/documents/upload",
  async (c) => {
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

      const fileName = file.name || "uploaded_file";
      const ext = fileName.split(".").pop()?.toLowerCase() || "";

      // 使用 ParserRegistry 校验文件类型（替代硬编码 supportedExts）
      const parserRegistry = getParserRegistry();
      const parser = parserRegistry.getParser({
        filename: fileName,
        mimeType: file.type || undefined,
      });

      if (!parser) {
        const supportedNames = parserRegistry.listParsers().join("、");
        return c.json(
          { detail: `不支持的文件类型 .${ext}。支持的解析器：${supportedNames}` },
          400,
        );
      }

      const MAX_SIZE = 15 * 1024 * 1024;
      if (file.size > MAX_SIZE) {
        return c.json(
          { detail: `文件过大（${(file.size / 1024 / 1024).toFixed(2)}MB），最大支持 15MB` },
          400,
        );
      }

      const isBinary = ext === "pdf";
      const title = fileName.replace(/\.[^/.]+$/, "");
      const docId = randomUUID();

      let content = "";
      let originalFilePath: string | null = null;

      if (isBinary) {
        // PDF：保存原始文件到 Storage，提取文本由 Worker 异步完成
        const arrayBuffer = await file.arrayBuffer();
        const rawBuffer = Buffer.from(arrayBuffer);

        const storage = getStorageProvider();
        const fileDir = `${docId}`;
        originalFilePath = await storage.save(
          `${fileDir}/${fileName}`,
          rawBuffer,
        );
      } else {
        // 文本格式：直接读取内容（向后兼容，Worker 仍会 normalize）
        content = await file.text();
        if (!content.trim()) {
          return c.json({ detail: "文件内容为空" }, 400);
        }
      }

      const doc = await prisma.knowledgeDocument.create({
        data: {
          id: docId,
          knowledgeBaseId: kbId,
          title,
          content,
          chunkCount: 0,
          status: "pending",
          originalFilename: fileName,
          originalFileType: ext,
          originalFileSize: file.size,
          originalFilePath,
        },
      });

      const { getIngestionQueue } = await import("../../../jobs/queues.js");
      const queue = getIngestionQueue();
      if (queue) {
        await queue.add("ingest", { docId: doc.id, kbId });
        logger.info({ docId: doc.id, title, ext }, "Ingestion job dispatched");
      } else {
        const ingestion = new KnowledgeIngestionService();
        await ingestion.processExistingDocument(doc.id, kbId);
      }

      const updatedDoc = await prisma.knowledgeDocument.findUnique({
        where: { id: doc.id },
      });
      return c.json(
        { ...updatedDoc, file_name: fileName, file_size: file.size },
        201,
      );
    } catch (e) {
      logger.error(e, "File upload failed");
      return c.json(
        { detail: e instanceof Error ? e.message : "文件上传处理失败" },
        500,
      );
    }
  },
);

// DELETE /api/knowledge/documents/:docId —— 删除文档（PG + Milvus 双删）
knowledgeManagementRoutes.delete("/api/knowledge/documents/:docId", async (c) => {
  const docId = c.req.param("docId");
  const ingestion = new KnowledgeIngestionService();
  const deleted = await ingestion.deleteDocument(docId);

  if (!deleted) {
    return c.json({ detail: "文档不存在" }, 404);
  }

  return c.json({ status: "deleted" });
});

// GET /api/knowledge/documents/:docId/chunks —— 查看文档的所有切片
knowledgeManagementRoutes.get("/api/knowledge/documents/:docId/chunks", async (c) => {
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
  kb_ids: z.array(z.string()).nullable().optional(),
  top_k: z.number().int().min(1).max(20).default(3),
});

// POST /api/knowledge/search —— 知识库语义搜索
knowledgeManagementRoutes.post(
  "/api/knowledge/search",
  zValidator("json", searchSchema),
  async (c) => {
    const { query, kb_ids, top_k } = c.req.valid("json");

    const service = new KnowledgeService();
    const results = await service.search(query, kb_ids, top_k);

    return c.json({
      results,
      query,
      total: results.length,
    });
  },
);

// ════════════════════════════════════════════════════════════════
// 统计
// ════════════════════════════════════════════════════════════════

// GET /api/knowledge/stats —— 获取知识库整体统计
knowledgeManagementRoutes.get("/api/knowledge/stats", async (c) => {
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

// GET /api/knowledge/graph/stats —— 获取知识图谱统计
knowledgeManagementRoutes.get("/api/knowledge/graph/stats", async (c) => {
  const { getGraphStats } = await import("../../../services/neo4j.js");
  try {
    const stats = await getGraphStats();
    return c.json({
      available: stats !== null,
      nodeCount: stats?.nodeCount ?? 0,
      relationCount: stats?.relationCount ?? 0,
    });
  } catch (e) {
    logger.warn(e, "Failed to get graph stats");
    return c.json({ available: false, nodeCount: 0, relationCount: 0 });
  }
});
