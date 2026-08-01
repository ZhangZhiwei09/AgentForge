// 知识库管理路由 —— /api/knowledge/* 完整 CRUD + 搜索 + 统计
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../../../db.js";
import { KnowledgeService } from "../../../services/knowledge.js";
import { KnowledgeIngestionService } from "../../../services/knowledge-ingestion.js";
import { getDefaultEmbeddingProvider } from "../../../services/embeddings.js";
import { RecursiveTokenTextSplitter } from "../../../services/text-splitter.js";
import { getParserRegistry } from "../../../services/document-parser/index.js";
import { getStorageProvider } from "../../../services/storage/index.js";
import { logger } from "@agentforge/logger";
import { settings } from "../../../config.js";
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
    .min(50)
    .max(4000)
    .optional(),
  chunk_overlap_tokens: z
    .number()
    .int()
    .min(0)
    .optional(),
  // V3.4: 切分模式
  separator_mode: z.enum(["auto", "custom"]).default("auto").optional(),
  custom_separator: z.string().min(1).max(100).nullable().optional(),
  // V3.4: 层次分块（parent-child chunking）
  chunk_structure: z.enum(["paragraph", "hierarchical"]).default("paragraph").optional(),
  child_chunk_size_tokens: z.number().int().min(50).max(2000).nullable().optional(),
  child_chunk_overlap_tokens: z.number().int().min(0).nullable().optional(),
  // V3.5: 文本预处理规则
  remove_extra_spaces: z.boolean().default(true).optional(),
  remove_urls_emails: z.boolean().default(false).optional(),
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
  // 校验：hierarchical 模式下 child_chunk 参数
  if (data.chunk_structure === "hierarchical" && data.child_chunk_size_tokens != null) {
    const childOverlap = data.child_chunk_overlap_tokens ?? 0;
    if (childOverlap >= data.child_chunk_size_tokens * 0.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "child_chunk_overlap_tokens must be less than child_chunk_size_tokens * 0.5",
        path: ["child_chunk_overlap_tokens"],
      });
    }
  }
  // 校验：custom separator 模式下必须提供 custom_separator
  if (data.separator_mode === "custom" && !data.custom_separator) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "custom_separator is required when separator_mode is 'custom'",
      path: ["custom_separator"],
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
    .min(50)
    .max(4000)
    .optional(),
  chunk_overlap_tokens: z
    .number()
    .int()
    .min(0)
    .optional(),
  // V3.4: 切分模式
  separator_mode: z.enum(["auto", "custom"]).optional(),
  custom_separator: z.string().min(1).max(100).nullable().optional(),
  // V3.4: 层次分块
  chunk_structure: z.enum(["paragraph", "hierarchical"]).optional(),
  child_chunk_size_tokens: z.number().int().min(50).max(2000).nullable().optional(),
  child_chunk_overlap_tokens: z.number().int().min(0).nullable().optional(),
  // V3.5: 文本预处理规则
  remove_extra_spaces: z.boolean().optional(),
  remove_urls_emails: z.boolean().optional(),
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
  // 校验：hierarchical 模式下 child_chunk 参数
  if (data.chunk_structure === "hierarchical" && data.child_chunk_size_tokens != null) {
    const childOverlap = data.child_chunk_overlap_tokens ?? 0;
    if (childOverlap >= data.child_chunk_size_tokens * 0.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "child_chunk_overlap_tokens must be less than child_chunk_size_tokens * 0.5",
        path: ["child_chunk_overlap_tokens"],
      });
    }
  }
});

// POST /api/knowledge/bases —— 创建知识库
knowledgeManagementRoutes.post(
  "/api/knowledge/bases",
  zValidator("json", kbCreateSchema),
  async (c) => {
    const { name, description, chunk_size_tokens, chunk_overlap_tokens, separator_mode, custom_separator, chunk_structure, child_chunk_size_tokens, child_chunk_overlap_tokens, remove_extra_spaces, remove_urls_emails } =
      c.req.valid("json");

    const kb = await prisma.knowledgeBase.create({
      data: {
        id: randomUUID(),
        name,
        description,
        chunkSizeTokens: chunk_size_tokens,
        chunkOverlapTokens: chunk_overlap_tokens,
        separatorMode: separator_mode,
        customSeparator: custom_separator,
        chunkStructure: chunk_structure,
        childChunkSize: child_chunk_size_tokens,
        childChunkOverlap: child_chunk_overlap_tokens,
        removeExtraSpaces: remove_extra_spaces,
        removeUrlsEmails: remove_urls_emails,
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
        separator_mode: kb.separatorMode,
        custom_separator: kb.customSeparator,
        chunk_structure: kb.chunkStructure,
        child_chunk_size_tokens: kb.childChunkSize,
        child_chunk_overlap_tokens: kb.childChunkOverlap,
        remove_extra_spaces: kb.removeExtraSpaces,
        remove_urls_emails: kb.removeUrlsEmails,
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
    separator_mode: kb.separatorMode,
    custom_separator: kb.customSeparator,
    chunk_structure: kb.chunkStructure,
    child_chunk_size_tokens: kb.childChunkSize,
    child_chunk_overlap_tokens: kb.childChunkOverlap,
    remove_extra_spaces: kb.removeExtraSpaces,
    remove_urls_emails: kb.removeUrlsEmails,
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
    separator_mode: kb.separatorMode,
    custom_separator: kb.customSeparator,
    chunk_structure: kb.chunkStructure,
    child_chunk_size_tokens: kb.childChunkSize,
    child_chunk_overlap_tokens: kb.childChunkOverlap,
    remove_extra_spaces: kb.removeExtraSpaces,
    remove_urls_emails: kb.removeUrlsEmails,
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
      separatorMode?: string;
      customSeparator?: string | null;
      chunkStructure?: string;
      childChunkSize?: number | null;
      childChunkOverlap?: number | null;
      removeExtraSpaces?: boolean;
      removeUrlsEmails?: boolean;
    } = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined)
      updateData.description = data.description;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.chunk_size_tokens !== undefined)
      updateData.chunkSizeTokens = data.chunk_size_tokens;
    if (data.chunk_overlap_tokens !== undefined)
      updateData.chunkOverlapTokens = data.chunk_overlap_tokens;
    if (data.separator_mode !== undefined)
      updateData.separatorMode = data.separator_mode;
    if (data.custom_separator !== undefined)
      updateData.customSeparator = data.custom_separator;
    if (data.chunk_structure !== undefined)
      updateData.chunkStructure = data.chunk_structure;
    if (data.child_chunk_size_tokens !== undefined)
      updateData.childChunkSize = data.child_chunk_size_tokens;
    if (data.child_chunk_overlap_tokens !== undefined)
      updateData.childChunkOverlap = data.child_chunk_overlap_tokens;
    if (data.remove_extra_spaces !== undefined)
      updateData.removeExtraSpaces = data.remove_extra_spaces;
    if (data.remove_urls_emails !== undefined)
      updateData.removeUrlsEmails = data.remove_urls_emails;

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
      separator_mode: updated.separatorMode,
      custom_separator: updated.customSeparator,
      chunk_structure: updated.chunkStructure,
      child_chunk_size_tokens: updated.childChunkSize,
      child_chunk_overlap_tokens: updated.childChunkOverlap,
      remove_extra_spaces: updated.removeExtraSpaces,
      remove_urls_emails: updated.removeUrlsEmails,
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
  try {
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
  } catch (e) {
    logger.error({ docId, error: String(e) }, "Document detail fetch failed");
    return c.json({ detail: `文档加载失败: ${e instanceof Error ? e.message : "未知错误"}` }, 500);
  }
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

      // query param process=false 跳过入队，由前端在配置保存后显式触发
      const shouldProcess = c.req.query("process") !== "false";
      if (shouldProcess) {
        const { getIngestionQueue } = await import("../../../jobs/queues.js");
        const queue = getIngestionQueue();
        if (queue) {
          await queue.add("ingest", { docId: doc.id, kbId });
          logger.info({ docId: doc.id, title, ext }, "Ingestion job dispatched");
        } else {
          const ingestion = new KnowledgeIngestionService();
          await ingestion.processExistingDocument(doc.id, kbId);
        }
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

// POST /api/knowledge/bases/:kbId/process —— 将知识库中所有 pending 文档入队处理
// 用于上传向导在保存分块配置后显式触发处理，避免 Worker 在配置保存前竞态
knowledgeManagementRoutes.post(
  "/api/knowledge/bases/:kbId/process",
  async (c) => {
    const kbId = c.req.param("kbId");

    const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
    if (!kb) {
      return c.json({ detail: "知识库不存在" }, 404);
    }

    try {
      const pendingDocs = await prisma.knowledgeDocument.findMany({
        where: { knowledgeBaseId: kbId, status: "pending" },
        select: { id: true, title: true },
      });

      if (pendingDocs.length === 0) {
        return c.json({ processed: 0, message: "没有待处理的文档" });
      }

      const { getIngestionQueue } = await import("../../../jobs/queues.js");
      const queue = getIngestionQueue();

      let queued = 0;
      const failed: string[] = [];

      for (const doc of pendingDocs) {
        try {
          if (queue) {
            // jobId 用 docId 去重：同一文档重复调用不会创建重复 job
            await queue.add("ingest", { docId: doc.id, kbId }, { jobId: `ingest-${doc.id}` });
          } else {
            const ingestion = new KnowledgeIngestionService();
            await ingestion.processExistingDocument(doc.id, kbId);
          }
          queued++;
        } catch (err) {
          failed.push(doc.id);
          logger.error({ docId: doc.id, error: String(err) }, "Process endpoint: failed to queue document");
        }
      }

      logger.info({ kbId, queued, failed: failed.length }, "Process endpoint completed");
      return c.json({
        processed: queued,
        failed: failed.length > 0 ? failed.length : undefined,
        message: failed.length > 0
          ? `已入队 ${queued} 篇，${failed.length} 篇失败`
          : `已入队 ${queued} 篇文档`,
      });
    } catch (e) {
      logger.error({ kbId, error: String(e) }, "Process endpoint failed");
      return c.json(
        { detail: e instanceof Error ? e.message : "批量入队失败" },
        500,
      );
    }
  },
);

// DELETE /api/knowledge/documents/:docId —— 删除文档（PG + Elasticsearch 双删）
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

  return c.json(chunks.map((c) => ({
    id: c.id,
    documentId: c.documentId,
    knowledgeBaseId: c.knowledgeBaseId,
    content: c.content,
    chunkIndex: c.chunkIndex,
    tokenCount: c.tokenCount,
    enabled: c.enabled,
    qualityLabel: c.qualityLabel,
    sourceType: c.sourceType,
    parentChunkId: c.parentChunkId,
    createdAt: c.created_at,
  })));
});

// ════════════════════════════════════════════════════════════════
// 分块预览（不入库，仅预览）
// ════════════════════════════════════════════════════════════════

const chunkPreviewSchema = z.object({
  text: z.string().min(1).max(100000),
  chunk_size_tokens: z.number().int().min(50).max(4000).optional(),
  chunk_overlap_tokens: z.number().int().min(0).optional(),
  chunk_structure: z.enum(["paragraph", "hierarchical"]).default("paragraph").optional(),
  child_chunk_size_tokens: z.number().int().min(50).max(2000).optional(),
  child_chunk_overlap_tokens: z.number().int().min(0).optional(),
  separator_mode: z.enum(["auto", "custom"]).default("auto").optional(),
  custom_separator: z.string().min(1).max(100).nullable().optional(),
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
  if (data.chunk_structure === "hierarchical" && data.child_chunk_size_tokens != null) {
    const childOverlap = data.child_chunk_overlap_tokens ?? 0;
    if (childOverlap >= data.child_chunk_size_tokens * 0.5) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "child_chunk_overlap_tokens must be less than child_chunk_size_tokens * 0.5",
        path: ["child_chunk_overlap_tokens"],
      });
    }
  }
});

// POST /api/knowledge/chunk-preview —— 预览分块结果（不创建文档/不写入数据库）
knowledgeManagementRoutes.post(
  "/api/knowledge/chunk-preview",
  zValidator("json", chunkPreviewSchema),
  async (c) => {
    const {
      text, chunk_size_tokens, chunk_overlap_tokens, chunk_structure,
      child_chunk_size_tokens, child_chunk_overlap_tokens,
      separator_mode, custom_separator,
    } = c.req.valid("json");

    const fixedSep = separator_mode === "custom" && custom_separator
      ? custom_separator
      : undefined;

    const parentSize = chunk_size_tokens ?? settings.kbChunkSizeTokens;
    const parentOverlap = chunk_overlap_tokens ?? settings.kbChunkOverlapTokens;
    const splitter = new RecursiveTokenTextSplitter(
      parentSize, parentOverlap, undefined, fixedSep,
    );

    if (chunk_structure === "hierarchical") {
      const childSize = child_chunk_size_tokens ?? 400;
      const childOverlap = child_chunk_overlap_tokens ?? 60;
      const { parentChunks, childChunks } = splitter.splitHierarchical(text, childSize, childOverlap);

      const preview = parentChunks.map((parent, i) => ({
        index: i,
        content: parent.slice(0, 500) + (parent.length > 500 ? "..." : ""),
        token_count: splitter.tokenCount(parent),
        children: (childChunks.get(i) || []).map((child, j) => ({
          index: j,
          content: child.slice(0, 300) + (child.length > 300 ? "..." : ""),
          token_count: splitter.tokenCount(child),
        })),
      }));

      return c.json({
        chunk_structure: "hierarchical",
        total_parents: parentChunks.length,
        total_children: [...childChunks.values()].reduce((s, c) => s + c.length, 0),
        preview,
      });
    }

    // paragraph mode
    const chunks = splitter.splitText(text);
    const preview = chunks.map((chunk, i) => ({
      index: i,
      content: chunk.slice(0, 500) + (chunk.length > 500 ? "..." : ""),
      token_count: splitter.tokenCount(chunk),
    }));

    return c.json({
      chunk_structure: "paragraph",
      total: chunks.length,
      preview,
    });
  },
);

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
// 命中测试
// ════════════════════════════════════════════════════════════════

const hitTestingSchema = z.object({
  query: z.string().min(1).max(500),
  top_k: z.number().int().min(1).max(20).default(10),
  search_method: z.enum(["hybrid", "semantic", "keyword"]).default("hybrid"),
  reranking_enable: z.boolean().default(true),
  score_threshold: z.number().min(0).max(1).default(0),
});

// POST /api/knowledge/bases/:kbId/hit-testing —— 检索命中测试（用于调试分块参数和检索策略）
knowledgeManagementRoutes.post(
  "/api/knowledge/bases/:kbId/hit-testing",
  zValidator("json", hitTestingSchema),
  async (c) => {
    const kbId = c.req.param("kbId");
    const { query, top_k, search_method, reranking_enable, score_threshold } =
      c.req.valid("json");

    // 验证知识库存在
    const kb = await prisma.knowledgeBase.findUnique({ where: { id: kbId } });
    if (!kb) {
      return c.json({ detail: "知识库不存在" }, 404);
    }

    const service = new KnowledgeService();
    const startedAt = Date.now();

    let rawResults: Array<{
      chunkId: string;
      docId: string;
      kbId: string;
      content: string;
      score: number;
      fusionScore?: number;
      rerankScore?: number;
      recallSources: ("pgvector" | "elasticsearch")[];
      chunkIndex: number;
      docTitle: string;
      parentChunk?: { id: string; content: string };
    }> = [];

    if (search_method === "hybrid") {
      rawResults = await service.searchHybrid({
        query,
        kbIds: [kbId],
        topK: top_k,
        useReranker: reranking_enable,
      });
    } else if (search_method === "semantic") {
      const provider = getDefaultEmbeddingProvider();
      if (provider) {
        const queryVec = await provider.embedSingle(query);
        if (queryVec) {
          const denseResults = await service.searchByVector(queryVec, [kbId], top_k);
          rawResults = denseResults.map((r) => ({
            ...r,
            score: r.sourceScore,
            fusionScore: r.sourceScore,
            recallSources: ["pgvector" as const],
          }));
        }
      }
    } else if (search_method === "keyword") {
      const sparseResults = await service.searchByKeyword(query, [kbId], top_k);
      rawResults = sparseResults.map((r) => ({
        ...r,
        score: r.sourceScore,
        fusionScore: r.sourceScore,
        recallSources: ["elasticsearch" as const],
      }));
    }

    const elapsedMs = Date.now() - startedAt;

    // 分数阈值过滤
    const filtered = score_threshold > 0
      ? rawResults.filter((r) => r.score >= score_threshold)
      : rawResults;

    // 构建响应
    const results = filtered.map((r) => ({
      chunk_id: r.chunkId,
      content: r.content,
      score: r.score,
      fusion_score: r.fusionScore,
      rerank_score: r.rerankScore,
      recall_sources: r.recallSources,
      chunk_index: r.chunkIndex,
      document: {
        id: r.docId,
        title: r.docTitle,
      },
      parent_chunk: r.parentChunk || null,
    }));

    // V3.5: 异步写入审计日志（fire-and-forget，不阻塞响应）
    prisma.knowledgeQueryLog.create({
      data: {
        id: randomUUID(),
        kbId,
        query,
        method: search_method,
        results: results.length,
        source: "hit_testing",
        elapsedMs,
      },
    }).catch((e) =>
      logger.warn({ error: String(e) }, "Failed to write query audit log"),
    );

    return c.json({
      query: { content: query },
      results,
      elapsed_ms: elapsedMs,
    });
  },
);

// ════════════════════════════════════════════════════════════════
// 统计
// ════════════════════════════════════════════════════════════════

// GET /api/knowledge/stats —— 获取知识库整体统计
knowledgeManagementRoutes.get("/api/knowledge/stats", async (c) => {
  const service = new KnowledgeService();
  const retrievalStats = await service.getCollectionStats();

  const kbCount = await prisma.knowledgeBase.count();
  const docCount = await prisma.knowledgeDocument.count();
  const chunkCount = await prisma.knowledgeChunk.count();

  return c.json({
    knowledge_bases: kbCount,
    documents: docCount,
    chunks: chunkCount,
    retrieval: retrievalStats,
  });
});
