// 知识库文档摄取服务 —— 将文档切分、向量化，写入 Milvus 和 PostgreSQL
// 摄取流程：Document(PENDING) → PARSING → NORMALIZING → INGESTING → COMPLETED/FAILED
// V2.2: 集成 ParserRegistry + Normalizer + Quality Gate + State Machine
// 同时包含种子数据（客服 FAQ）和种子函数
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import {
  getMilvusClient,
  MILVUS_KNOWLEDGE_COLLECTION,
  ensureKnowledgeCollection,
} from "./milvus.js";
import { invalidateCitationCache } from "./agent-runtime/citation-verifier.js";
import { getDefaultEmbeddingProvider } from "./embeddings.js";
import { RecursiveTokenTextSplitter } from "./text-splitter.js";
import { tokenize } from "./tokenizer.js";
import { countEmbeddingTokens } from "./embedding-tokenizer.js";
import { getParserRegistry } from "./document-parser/index.js";
import { NormalizerService } from "./document-normalizer/index.js";
import { getStorageProvider } from "./storage/index.js";
import {
  bulkIndexDocuments,
  deleteByDocumentIds,
  isESAvailable,
  ensureKnowledgeIndex,
  type ESDocument,
} from "./elasticsearch.js";
import type { TextMetrics } from "./document-normalizer/index.js";
import type { Prisma } from "@agentforge/database";
import { logger } from "@agentforge/logger";
import { settings } from "../config.js";

// Quality gate result — returned by evaluateQuality(), consumed by Worker
type QualityDecision = "proceed" | "flag_low" | "reject_scan";

export class KnowledgeIngestionService {
  private normalizer: NormalizerService;
  private collectionLoaded = false;

  // 默认分片参数（来自环境变量，可被 KB 级配置覆盖）
  private defaultChunkSizeTokens: number;
  private defaultChunkOverlapTokens: number;

  constructor() {
    this.normalizer = new NormalizerService();
    this.defaultChunkSizeTokens = settings.kbChunkSizeTokens;
    this.defaultChunkOverlapTokens = settings.kbChunkOverlapTokens;
  }

  /**
   * 获取或创建 splitter 实例（Token-aware，每次按配置创建）。
   *
   * 优先级：KB 级别配置 > 环境变量默认值
   */
  private getSplitter(
    kbChunkSize?: number,
    kbChunkOverlap?: number,
    fixedSeparator?: string,
  ): RecursiveTokenTextSplitter {
    const size = kbChunkSize ?? this.defaultChunkSizeTokens;
    const overlap = kbChunkOverlap ?? this.defaultChunkOverlapTokens;
    return new RecursiveTokenTextSplitter(size, overlap, undefined, fixedSeparator);
  }

  /**
   * 读取知识库的分片配置（如已设置）。
   * 返回 null 表示 KB 未自定义配置，应使用默认值。
   */
  private async getKBSplitConfig(kbId: string): Promise<{
    chunkSizeTokens?: number;
    chunkOverlapTokens?: number;
    fixedSeparator?: string;
    chunkStructure?: string;
    childChunkSize?: number;
    childChunkOverlap?: number;
    removeExtraSpaces?: boolean;
    removeUrlsEmails?: boolean;
  }> {
    const kb = await prisma.knowledgeBase.findUnique({
      where: { id: kbId },
      select: {
        chunkSizeTokens: true,
        chunkOverlapTokens: true,
        separatorMode: true,
        customSeparator: true,
        chunkStructure: true,
        childChunkSize: true,
        childChunkOverlap: true,
        removeExtraSpaces: true,
        removeUrlsEmails: true,
      },
    });
    // 仅在 separatorMode 为 "custom" 且 customSeparator 非空时启用固定分隔符
    const fixedSeparator =
      kb?.separatorMode === "custom" && kb?.customSeparator
        ? kb.customSeparator
        : undefined;
    return {
      chunkSizeTokens: kb?.chunkSizeTokens ?? undefined,
      chunkOverlapTokens: kb?.chunkOverlapTokens ?? undefined,
      fixedSeparator,
      chunkStructure: kb?.chunkStructure ?? undefined,
      childChunkSize: kb?.childChunkSize ?? undefined,
      childChunkOverlap: kb?.childChunkOverlap ?? undefined,
      removeExtraSpaces: kb?.removeExtraSpaces ?? undefined,
      removeUrlsEmails: kb?.removeUrlsEmails ?? undefined,
    };
  }

  private async ensureCollection() {
    if (!this.collectionLoaded) {
      await ensureKnowledgeCollection();
      this.collectionLoaded = true;
    }
  }

  // 记录阶段完成时间戳 + 进度更新（参考 Dify per-stage timestamp 设计）
  private async recordStageComplete(
    docId: string,
    stageField: string,
    progress: { phase: string; progress: number; total: number; message: string },
  ): Promise<void> {
    const now = new Date();
    const data: Record<string, unknown> = {
      [stageField]: now,
      processingDetail: this.setProgress(
        progress.phase,
        progress.progress,
        progress.total,
        progress.message,
      ),
    };
    await prisma.knowledgeDocument.update({ where: { id: docId }, data });
  }

  // 处理进度详情
  private setProgress(
    phase: string,
    progress: number,
    total: number,
    message: string,
  ): string {
    return JSON.stringify({ phase, progress, total, message, updatedAt: new Date().toISOString() });
  }

  // 更新文档状态，可选记录错误信息、递增重试计数和处理进度
  private async updateDocumentStatus(
    docId: string,
    status: string,
    opts?: {
      errorMessage?: string;
      incrementRetry?: boolean;
      progress?: { phase: string; progress: number; total: number; message: string };
    },
  ): Promise<void> {
    const data: Record<string, unknown> = { status };
    if (opts?.errorMessage !== undefined) {
      data.errorMessage = opts.errorMessage;
    }
    if (opts?.incrementRetry) {
      data.retryCount = { increment: 1 };
    }
    if (opts?.progress) {
      data.processingDetail = this.setProgress(
        opts.progress.phase,
        opts.progress.progress,
        opts.progress.total,
        opts.progress.message,
      );
    }
    await prisma.knowledgeDocument.update({ where: { id: docId }, data });
  }

  // Quality gate — determines whether to proceed, flag, or reject based on text metrics.
  // ONLY this method makes quality decisions. computeMetrics() is pure data.
  private evaluateQuality(m: TextMetrics): QualityDecision {
    if (m.charCount === 0) return "reject_scan";
    // Very low density with minimal content → likely scan/image-only PDF
    if (m.textDensity < 0.05 && m.charCount < 100) return "reject_scan";
    // Low density but some content → flag for future review
    if (m.textDensity < 0.1) return "flag_low";
    return "proceed";
  }

  // 摄取单篇文档：创建记录 → 切分 → 向量化 → 双写
  async ingestDocument(kbId: string, title: string, content: string) {
    // 读取 KB 分片配置
    const kbConfig = await this.getKBSplitConfig(kbId);
    const splitter = this.getSplitter(kbConfig.chunkSizeTokens, kbConfig.chunkOverlapTokens, kbConfig.fixedSeparator);

    // 1. 创建 Document 记录，状态标记为 processing
    const doc = await prisma.knowledgeDocument.create({
      data: {
        id: randomUUID(),
        knowledgeBaseId: kbId,
        title,
        content,
        chunkCount: 0,
        status: "processing",
      },
    });

    try {
      // 2. 文本切分为 chunk
      const chunks = splitter.splitText(content);
      if (!chunks.length) {
        // 空内容：直接标记完成
        await prisma.knowledgeDocument.update({
          where: { id: doc.id },
          data: { status: "completed", chunkCount: 0 },
        });
        return await prisma.knowledgeDocument.findUnique({
          where: { id: doc.id },
        })!;
      }

      // 3. 逐 chunk 向量化并写入 Milvus + PG
      await this.ingestChunks(doc.id, kbId, chunks);

      // 4. 更新文档状态为 completed
      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { chunkCount: chunks.length, status: "completed" },
      });

      logger.info({ title, chunks: chunks.length }, "Document ingested");
      invalidateCitationCache();
      return (await prisma.knowledgeDocument.findUnique({
        where: { id: doc.id },
      }))!;
    } catch (e) {
      // 摄取失败：标记为 failed，抛出异常让调用方感知
      logger.error(e, `Document ingestion failed: ${title}`);
      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: "failed" },
      });
      throw e;
    }
  }

  // 批量摄取：逐文档串行处理（避免并发写入 Milvus 的竞态问题）
  async batchIngest(
    kbId: string,
    documents: Array<{ title: string; content: string }>,
  ) {
    const results = [];
    for (const docData of documents) {
      const doc = await this.ingestDocument(
        kbId,
        docData.title,
        docData.content,
      );
      results.push(doc);
    }
    return results;
  }

  // P1-1 / V2.2: Worker 专用方法 — 处理已创建的文档。
  // 完整状态机: PENDING → PARSING → NORMALIZING → (quality gate) → INGESTING → COMPLETED / FAILED
  async processExistingDocument(docId: string, kbId: string): Promise<void> {
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: docId },
    });
    if (!doc) throw new Error(`Document ${docId} not found`);

    // 记录处理开始时间
    await prisma.knowledgeDocument.update({
      where: { id: docId },
      data: { processingStartedAt: new Date() },
    });

    // 推断来源类型：有原始文件 → 文件上传，否则 → 手动/文本
    const sourceType: string = doc.originalFileType
      ? (doc.originalFileType === "pdf" ? "pdf" : "text")
      : doc.content
        ? "manual"
        : "text";
    let qualityLabel: string = "good";
    let content = doc.content;

    try {
      // ── Phase 1: PARSING ──
      // 如果文档有原始文件路径但无内容，则需要从文件解析
      if (doc.originalFilePath && (!content || !content.trim())) {
        const fileSizeMB = doc.originalFileSize
          ? (doc.originalFileSize / 1024 / 1024).toFixed(1) + "MB"
          : "未知大小";
        await this.updateDocumentStatus(docId, "downloading", {
          progress: { phase: "downloading", progress: 0, total: 1, message: `正在从存储下载文件（${fileSizeMB}）...` },
        });

        const parserRegistry = getParserRegistry();
        const parser = parserRegistry.getParser({
          filename: doc.originalFilename ?? doc.originalFilePath,
          mimeType: doc.originalFileType === "pdf"
            ? "application/pdf"
            : undefined,
        });

        if (!parser) {
          throw new Error(
            `无法识别文件类型: ${doc.originalFilename ?? doc.originalFilePath}`,
          );
        }

        const storage = getStorageProvider();
        const fileBuffer = await storage.read(doc.originalFilePath);

        // 记录下载完成时间戳
        await this.recordStageComplete(docId, "downloadingCompletedAt", {
          phase: "downloading", progress: 10, total: 100, message: "文件下载完成，开始解析...",
        });

        await this.updateDocumentStatus(docId, "parsing", {
          progress: { phase: "parsing", progress: 0, total: 1, message: `正在用 ${parser.name} 解析器提取文本（${fileSizeMB}）...` },
        });
        const parsed = await parser.parse(fileBuffer);

        // 将解析出的文本存回文档
        content = parsed.text;
        await prisma.knowledgeDocument.update({
          where: { id: docId },
          data: {
            content,
            qualityLabel: parsed.metadata.charCount === 0
              ? "low"
              : undefined,
          },
        });

        logger.info(
          { docId, parser: parser.name, charCount: parsed.metadata.charCount },
          "Document parsed",
        );

        // 记录解析完成时间戳
        await this.recordStageComplete(docId, "parsingCompletedAt", {
          phase: "parsing", progress: 25, total: 100, message: `解析完成，共提取 ${parsed.metadata.charCount} 个字符`,
        });

        // V3.0: 如果 parser 返回的是多模态文档（含 assets），上传资产到 MinIO
        const parsedExtended = parsed as {
          text: string;
          _assets?: import("./document-parser/types.js").AssetRef[];
        };
        if (parsedExtended._assets && parsedExtended._assets.length > 0) {
          await this.updateDocumentStatus(docId, "extracting_assets");

          const storage = getStorageProvider();
          for (const asset of parsedExtended._assets) {
            try {
              // 读取资产 buffer 并上传到 MinIO
              const assetBuffer = Buffer.from(
                asset.localPath.includes("assets/")
                  ? "" // 内存中的资产（Word parser 提取的图片）
                  : "",
              );
              // 注：Word parser 的图片已缓存在内存中，这里需要重构以支持
              // 当前实现：如果 storage 是 MinIO，获取公开 URL；否则跳过
              const publicUrl = await storage.getPublicUrl(
                asset.localPath,
                86400,
              );
              asset.publicUrl = publicUrl;
              asset.minioKey = asset.localPath;

              // 替换 Markdown 中的资产占位符
              if (content.includes(`{{ASSET:${asset.id}}}`)) {
                content = content.replace(
                  `{{ASSET:${asset.id}}}`,
                  `![${asset.description || "图片"}](${publicUrl})`,
                );
              }
            } catch (e) {
              logger.warn(
                { assetId: asset.id, error: String(e) },
                "Asset upload failed (non-blocking)",
              );
            }
          }

          // 更新文档内容（已被资产 URL 替换后的版本）
          if (content !== doc.content) {
            await prisma.knowledgeDocument.update({
              where: { id: docId },
              data: { content },
            });
          }
        }
      }

      // ── Phase 2: NORMALIZING ──
      const contentLen = content.length;
      await this.updateDocumentStatus(docId, "normalizing", {
        progress: { phase: "normalizing", progress: 0, total: 1, message: `正在清洗文本...` },
      });

      // 读取 KB 预处理规则
      const preprocessingConfig = await this.getKBSplitConfig(kbId);
      const preprocessingRules = {
        removeExtraSpaces: preprocessingConfig.removeExtraSpaces ?? true,
        removeUrlsEmails: preprocessingConfig.removeUrlsEmails ?? false,
      };
      const normalized = this.normalizer.normalizeWithRules(
        content,
        preprocessingRules,
        doc.originalFileType === "pdf" ? undefined : undefined,
      );

      logger.info(
        { docId, beforeChars: contentLen, afterChars: normalized.text.length, density: normalized.metrics.textDensity },
        "Document normalized",
      );
      // If we have original file info, pass pageCount context
      // (pageCount is not stored on KnowledgeDocument yet, skip for now)

      // ── Quality Gate ──
      const decision = this.evaluateQuality(normalized.metrics);
      if (decision === "reject_scan") {
        await this.updateDocumentStatus(docId, "failed", {
          errorMessage: "SCAN_OR_IMAGE_PDF: 无法提取文本内容，可能是扫描件或图片型 PDF",
        });
        logger.warn(
          { docId, metrics: normalized.metrics },
          "Document rejected by quality gate (scan/image detected)",
        );
        return; // 不抛异常，明确标记为 FAILED 但不触发 BullMQ 重试
      }
      if (decision === "flag_low") {
        qualityLabel = "low";
        logger.info(
          { docId, metrics: normalized.metrics },
          "Document flagged as low quality, proceeding with ingestion",
        );
      }

      // 将 normalize 后的文本回写（去除了多余空白/换行）
      if (normalized.text !== content) {
        await prisma.knowledgeDocument.update({
          where: { id: docId },
          data: { content: normalized.text },
        });
        content = normalized.text;
      }

      // 记录清洗完成时间戳
      await this.recordStageComplete(docId, "normalizingCompletedAt", {
        phase: "normalizing", progress: 35, total: 100,
        message: `文本清洗完成（${content.length} 字符，密度 ${normalized.metrics.textDensity.toFixed(2)}）`,
      });

      // ── Phase 3: INGESTING ──
      // 3a. 分块（chunking）
      await this.updateDocumentStatus(docId, "chunking", {
        progress: { phase: "chunking", progress: 0, total: 1, message: "正在将文本切分为分块..." },
      });

      // 读取 KB 分片配置
      const kbConfig = await this.getKBSplitConfig(kbId);
      const isHierarchical = kbConfig.chunkStructure === "hierarchical";

      if (isHierarchical) {
        // ── 层次分块路径 ──
        const splitter = this.getSplitter(kbConfig.chunkSizeTokens, kbConfig.chunkOverlapTokens, kbConfig.fixedSeparator);
        const childSize = kbConfig.childChunkSize ?? settings.kbChildChunkSizeTokens ?? 400;
        const childOverlap = kbConfig.childChunkOverlap ?? settings.kbChildChunkOverlapTokens ?? 60;
        const { parentChunks, childChunks } = splitter.splitHierarchical(content, childSize, childOverlap);

        logger.info(
          { docId, parentCount: parentChunks.length, totalChildren: [...childChunks.values()].reduce((s, c) => s + c.length, 0) },
          "Hierarchical text split into parent/child chunks",
        );

        if (!parentChunks.length) {
          await this.updateDocumentStatus(docId, "completed", {
            progress: { phase: "completed", progress: 1, total: 1, message: "文档无有效文本内容，已跳过向量化" },
          });
          return;
        }

        // 1) 创建 parent chunk 记录（仅 PG，不向量化）
        const parentChunkIds = new Map<number, string>();
        const parentTokenCounts = new Map<string, number>();
        await this.updateDocumentStatus(docId, "writing_db", {
          progress: { phase: "writing_db", progress: 0, total: parentChunks.length, message: `正在写入 ${parentChunks.length} 个父分块...` },
        });

        for (let i = 0; i < parentChunks.length; i++) {
          const pId = randomUUID();
          parentChunkIds.set(i, pId);
          const tokenCount = await countEmbeddingTokens(parentChunks[i]);
          parentTokenCounts.set(pId, tokenCount);

          await prisma.knowledgeChunk.create({
            data: {
              id: pId,
              documentId: docId,
              knowledgeBaseId: kbId,
              chunkIndex: i,
              content: parentChunks[i],
              tokenCount,
              sourceType: sourceType ?? null,
              qualityLabel: qualityLabel ?? null,
              // parentChunkId 为 null → 表示这是一个 parent chunk
            },
          });
        }

        // 2) 收集所有 child chunks（带 parent 映射）
        let totalChildCount = 0;
        const allChildTexts: string[] = [];
        const childParentMap = new Map<number, string>();  // childIndex → parentChunkId

        for (const [parentIdx, children] of childChunks.entries()) {
          const parentId = parentChunkIds.get(parentIdx)!;
          for (const childText of children) {
            allChildTexts.push(childText);
            childParentMap.set(totalChildCount, parentId);
            totalChildCount++;
          }
        }

        logger.info({ docId, totalChildren: totalChildCount }, "Child chunks collected for hierarchical ingestion");

        await this.recordStageComplete(docId, "chunkingCompletedAt", {
          phase: "chunking", progress: 50, total: 100,
          message: `层次分块完成：${parentChunks.length} 父分块 / ${totalChildCount} 子分块`,
        });

        // 3) 向量化 + 写入 child chunks（带 parentChunkId）
        if (totalChildCount > 0) {
          await this.updateDocumentStatus(docId, "embedding", {
            progress: { phase: "embedding", progress: 0, total: totalChildCount, message: `正在向量化第 0/${totalChildCount} 个子分块...` },
          });
          await this.ingestChunks(docId, kbId, allChildTexts, sourceType, qualityLabel, childParentMap);
        }

        // 总 chunk 数 = parent + child
        const totalChunkCount = parentChunks.length + totalChildCount;
        await prisma.knowledgeDocument.update({
          where: { id: docId },
          data: {
            chunkCount: totalChunkCount,
            status: "completed",
            qualityLabel: qualityLabel,
            processingDetail: this.setProgress("completed", totalChunkCount, totalChunkCount, `层次分块完成：${parentChunks.length} 父分块 + ${totalChildCount} 子分块`),
          },
        });
      } else {
        // ── 标准 paragraph 分块路径（现有逻辑） ──
        const splitter = this.getSplitter(kbConfig.chunkSizeTokens, kbConfig.chunkOverlapTokens, kbConfig.fixedSeparator);
        const chunks = splitter.splitText(content);

        logger.info({ docId, chunkCount: chunks.length, charCount: content.length }, "Text split into chunks");

        if (!chunks.length) {
          await this.updateDocumentStatus(docId, "completed", {
            progress: { phase: "completed", progress: 1, total: 1, message: "文档无有效文本内容，已跳过向量化" },
          });
          return;
        }

        // 记录分段完成时间戳
        await this.recordStageComplete(docId, "chunkingCompletedAt", {
          phase: "chunking", progress: 50, total: 100,
          message: `分段完成，共切分为 ${chunks.length} 个分块`,
        });

        // 3b. 向量化 + 双写，带 sourceType 和 qualityLabel
        await this.updateDocumentStatus(docId, "embedding", {
          progress: { phase: "embedding", progress: 0, total: chunks.length, message: `正在向量化第 0/${chunks.length} 个分块...` },
        });
        await this.ingestChunks(docId, kbId, chunks, sourceType, qualityLabel);

        // 记录向量化+写入完成时间戳
        await this.recordStageComplete(docId, "embeddingCompletedAt", {
          phase: "writing_db", progress: 95, total: 100,
          message: `向量化与写入完成，共处理 ${chunks.length} 个分块`,
        });

        // ── Phase 4: COMPLETED (paragraph path) ──
        await prisma.knowledgeDocument.update({
          where: { id: docId },
          data: {
            chunkCount: chunks.length,
            status: "completed",
            qualityLabel: qualityLabel,
            processingDetail: this.setProgress("completed", chunks.length, chunks.length, `处理完成，共生成 ${chunks.length} 个分块`),
          },
        });

        // V3.0: 异步触发图谱抽取（不阻塞文档完成状态）
        await prisma.knowledgeDocument.update({
          where: { id: docId },
          data: {
            processingDetail: this.setProgress("graph_extracting", 0, 1, "正在构建知识图谱..."),
          },
        });
        this.triggerGraphExtraction(docId, kbId, chunks, sourceType).catch(
          (e) => logger.warn({ docId, error: String(e) }, "Graph extraction trigger failed"),
        );

        logger.info(
          { docId, chunks: chunks.length, quality: qualityLabel, sourceType },
          "Document processed by worker",
        );
      }

      invalidateCitationCache();
    } catch (e) {
      const errorMessage =
        e instanceof Error ? e.message : "文档处理失败";
      logger.error(
        { docId, error: errorMessage },
        "Worker document processing failed",
      );
      await this.updateDocumentStatus(docId, "failed", {
        errorMessage,
        incrementRetry: true,
        progress: { phase: "failed", progress: 0, total: 1, message: `处理失败：${errorMessage}` },
      });
      throw e; // 重新抛出让 BullMQ 重试
    }
  }

  // V3.0: 触发图谱抽取（异步，不阻塞主流程）
  private async triggerGraphExtraction(
    docId: string,
    kbId: string,
    chunks: string[],
    sourceType?: string,
  ): Promise<void> {
    try {
      const { getGraphExtractionService } = await import(
        "./graph-extraction.js"
      );
      const extractor = getGraphExtractionService();

      // 查询已创建的 chunk IDs
      const chunkRecords = await prisma.knowledgeChunk.findMany({
        where: { documentId: docId },
        select: { id: true, content: true },
        orderBy: { chunkIndex: "asc" },
      });

      // 逐 chunk 抽取（控制并发，一次处理 3 个）
      const CONCURRENCY = 3;
      for (let i = 0; i < chunkRecords.length; i += CONCURRENCY) {
        const batch = chunkRecords.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map((chunk) =>
            extractor
              .extractFromChunk(chunk.id, chunk.content, kbId, docId)
              .catch((e) =>
                logger.warn(
                  { chunkId: chunk.id },
                  e,
                  "Individual chunk graph extraction failed",
                ),
              ),
          ),
        );
      }

      logger.info(
        { docId, chunksProcessed: chunkRecords.length },
        "Graph extraction triggered",
      );
    } catch (e) {
      logger.warn({ docId, error: String(e) }, "Graph extraction trigger failed");
    }
  }

  // Chunk 向量化 + 双写核心逻辑（V3.0: 追加 PGVector embedding + ES 索引）
  // V3.4: childParentMap 用于层次分块时映射 child → parent chunk ID
  private async ingestChunks(
    docId: string,
    kbId: string,
    chunkTexts: string[],
    sourceType?: string,
    qualityLabel?: string,
    childParentMap?: Map<number, string>,  // childIndex → parentChunkId
  ) {
    const provider = getDefaultEmbeddingProvider();
    if (!provider) {
      throw new Error("No embedding provider configured");
    }

    await this.ensureCollection();

    // 1. 批量生成 dense 向量
    const totalChunks = chunkTexts.length;
    await this.updateDocumentStatus(docId, "embedding", {
      progress: { phase: "embedding", progress: 0, total: totalChunks, message: `正在向量化 ${totalChunks} 个分块（通过 ${provider.modelName}）...` },
    });
    const denseVecs = await provider.embed(chunkTexts);
    if (!denseVecs || denseVecs.length !== chunkTexts.length) {
      throw new Error("Embedding failed or returned mismatched count");
    }

    await this.updateDocumentStatus(docId, "writing_db", {
      progress: { phase: "writing_db", progress: 0, total: totalChunks, message: `向量化完成，正在写入第 0/${totalChunks} 个分块...` },
    });

    // 2. 批量插入 Milvus（过渡期双写，后续版本移除）
    const chunkIds = chunkTexts.map(() => randomUUID());
    const client = getMilvusClient();

    const rows = chunkTexts.map((text, i) => ({
      chunk_id: chunkIds[i],
      kb_id: kbId,
      dense_vector: denseVecs[i],
      content: text.slice(0, 4096),
    }));

    const mr = await client.insert({
      collection_name: MILVUS_KNOWLEDGE_COLLECTION,
      fields_data: rows,
    });

    // 3. 保存 chunk 元数据到 PG（包含 Milvus ID 和 PGVector embedding）
    const milvusIds = (mr.IDs as any)?.int_id?.data || [];

    // 获取文档标题（用于 ES 索引）
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: docId },
      select: { title: true },
    });
    const docTitle = doc?.title || "";

    // ES 文档批量（按可用性延迟写入）
    const esDocs: ESDocument[] = [];

    // 预计算所有 chunk 的 embedding token 数（异步批量）
    const embeddingTokenCounts = await Promise.all(
      chunkTexts.map((t) => countEmbeddingTokens(t)),
    );

    for (let i = 0; i < chunkIds.length; i++) {
      const vecLiteral = `[${denseVecs[i].join(",")}]`;

      // 先创建 chunk 记录，再通过 raw SQL 补充 embedding
      const parentId = childParentMap?.get(i);
      await prisma.knowledgeChunk.create({
        data: {
          id: chunkIds[i],
          documentId: docId,
          knowledgeBaseId: kbId,
          chunkIndex: i,
          content: chunkTexts[i],
          tokenCount: embeddingTokenCounts[i],
          milvusId: milvusIds[i] != null ? BigInt(milvusIds[i]) : null,
          sourceType: sourceType ?? null,
          qualityLabel: qualityLabel ?? null,
          parentChunkId: parentId ?? null,
        },
      });

      // V3.0: PGVector embedding 向量写入（CREATE 之后 UPDATE，Prisma 不直接支持 vector 类型）
      await prisma.$executeRawUnsafe(
        `UPDATE knowledge_chunks SET embedding = $1::vector WHERE id = $2`,
        vecLiteral,
        chunkIds[i],
      );

      // 构建 ES 文档
      esDocs.push({
        chunkId: chunkIds[i],
        kbId,
        docId,
        title: docTitle,
        content: chunkTexts[i],
        sourceType: sourceType ?? undefined,
        qualityLabel: qualityLabel ?? undefined,
        createdAt: new Date().toISOString(),
      });

      // 每 20 个块或最后一个块时更新进度
      if ((i + 1) % 20 === 0 || i === chunkIds.length - 1) {
        await this.updateDocumentStatus(docId, "writing_db", {
          progress: { phase: "writing_db", progress: i + 1, total: chunkIds.length, message: `正在写入第 ${i + 1}/${chunkIds.length} 个分块...` },
        });
      }
    }

    // 4. 构建倒排索引（保留用于 PG 端关键词回退检索）
    for (let i = 0; i < chunkTexts.length; i++) {
      const tokens = tokenize(chunkTexts[i]);
      const termFreqMap = new Map<string, number>();
      for (const t of tokens) {
        termFreqMap.set(t, (termFreqMap.get(t) ?? 0) + 1);
      }
      if (termFreqMap.size > 0) {
        await prisma.knowledgeInvertedIndex.createMany({
          data: Array.from(termFreqMap.entries()).map(([term, freq]) => ({
            id: randomUUID(),
            term,
            chunkId: chunkIds[i],
            kbId,
            termFreq: freq,
          })),
        });
      }
    }

    // 5. V3.0: 索引到 Elasticsearch（异步，失败不阻塞主流程）
    try {
      if (await isESAvailable()) {
        await ensureKnowledgeIndex();
        await bulkIndexDocuments(esDocs);
      } else {
        logger.debug("ES unavailable, skipping ES index during ingestion");
      }
    } catch (e) {
      logger.warn({ docId, count: esDocs.length, error: String(e) }, "ES indexing failed during ingestion (non-blocking)");
    }
  }

  // 删除文档：同时清理 PG 和 Milvus 中的数据
  async deleteDocument(docId: string): Promise<boolean> {
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: docId },
    });
    if (!doc) return false;

    // 查出所有 chunk 的 milvus ID
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { documentId: docId },
      select: { id: true, milvusId: true },
    });
    const milvusIds = chunks
      .filter((c) => c.milvusId !== null)
      .map((c) => Number(c.milvusId));

    // 从 Milvus 删除向量
    if (milvusIds.length > 0) {
      try {
        await this.ensureCollection();
        const client = getMilvusClient();
        const idExpr = milvusIds.join(", ");
        await client.delete({
          collection_name: MILVUS_KNOWLEDGE_COLLECTION,
          filter: `id in [${idExpr}]`,
        });
      } catch (e) {
        logger.warn(e, "Milvus delete failed during document cleanup");
      }
    }

    // 清理倒排索引（用 chunk ID 精确删除）
    const chunkIds = chunks.map((c) => c.id);
    await prisma.knowledgeInvertedIndex.deleteMany({
      where: { chunkId: { in: chunkIds } },
    });

    // V3.0: 清理 Elasticsearch 索引
    try {
      await deleteByDocumentIds([docId]);
    } catch (e) {
      logger.warn({ docId, error: String(e) }, "ES cleanup failed during document deletion (non-blocking)");
    }

    // 从 PG 删除（CASCADE 会自动删关联的 chunks 和 inverted_index）
    await prisma.knowledgeChunk.deleteMany({ where: { documentId: docId } });
    await prisma.knowledgeDocument.delete({ where: { id: docId } });

    logger.info({ docId, vectors: milvusIds.length }, "Document deleted");
    invalidateCitationCache();
    return true;
  }

  // 重建倒排索引：清空旧索引 → 重新分词 → 写入
  static async rebuildInvertedIndex(kbId?: string): Promise<void> {
    const whereClause: Prisma.KnowledgeChunkWhereInput = { enabled: true };
    if (kbId) whereClause.knowledgeBaseId = kbId;

    const chunks = await prisma.knowledgeChunk.findMany({
      where: whereClause,
      select: { id: true, content: true, knowledgeBaseId: true },
    });

    if (chunks.length === 0) {
      logger.info("No chunks to rebuild inverted index");
      return;
    }

    // 清空目标 KB 的旧索引
    if (kbId) {
      await prisma.knowledgeInvertedIndex.deleteMany({ where: { kbId } });
    } else {
      const kbIds = [...new Set(chunks.map((c) => c.knowledgeBaseId))];
      await prisma.knowledgeInvertedIndex.deleteMany({
        where: { kbId: { in: kbIds } },
      });
    }

    // 逐 chunk 重建分词和倒排索引
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.content);
      const termFreqMap = new Map<string, number>();
      for (const t of tokens) {
        termFreqMap.set(t, (termFreqMap.get(t) ?? 0) + 1);
      }

      // 更新 tokenCount
      await prisma.knowledgeChunk.update({
        where: { id: chunk.id },
        data: { tokenCount: tokens.length },
      });

      // 写入倒排索引
      if (termFreqMap.size > 0) {
        await prisma.knowledgeInvertedIndex.createMany({
          data: Array.from(termFreqMap.entries()).map(([term, freq]) => ({
            id: randomUUID(),
            term,
            chunkId: chunk.id,
            kbId: chunk.knowledgeBaseId,
            termFreq: freq,
          })),
        });
      }
    }

    logger.info({ chunks: chunks.length }, "Inverted index rebuilt");
  }

  // V3.0: 从 PG 重建 ES 索引（可用于 ES 数据丢失或迁移后的修复）
  static async rebuildESIndex(kbId?: string): Promise<void> {
    const esAvailable = await isESAvailable();
    if (!esAvailable) {
      logger.warn("ES not available, skipping rebuild");
      return;
    }

    await ensureKnowledgeIndex();

    const whereClause: Prisma.KnowledgeChunkWhereInput = { enabled: true };
    if (kbId) whereClause.knowledgeBaseId = kbId;

    const chunks = await prisma.knowledgeChunk.findMany({
      where: whereClause,
      select: {
        id: true,
        documentId: true,
        knowledgeBaseId: true,
        content: true,
        sourceType: true,
        qualityLabel: true,
        document: { select: { title: true } },
      },
    });

    if (chunks.length === 0) {
      logger.info("No chunks to rebuild ES index");
      return;
    }

    const esDocs: ESDocument[] = chunks.map((c) => ({
      chunkId: c.id,
      kbId: c.knowledgeBaseId,
      docId: c.documentId,
      title: c.document.title,
      content: c.content,
      sourceType: c.sourceType ?? undefined,
      qualityLabel: c.qualityLabel ?? undefined,
      createdAt: new Date().toISOString(),
    }));

    // 分批写入（每批 500 条）
    const BATCH = 500;
    for (let i = 0; i < esDocs.length; i += BATCH) {
      const batch = esDocs.slice(i, i + BATCH);
      await bulkIndexDocuments(batch);
    }

    logger.info({ count: esDocs.length }, "ES index rebuilt from PG");
  }
}

// ════════════════════════════════════════════════════════════════
// 种子数据：客服 FAQ 知识库
// ════════════════════════════════════════════════════════════════

const DEFAULT_KB_ID = "kb-a00000-0000-0000-0000-00000000001";

// 5 篇示例 FAQ 文档（中文客服场景）
const SAMPLE_FAQS = [
  {
    title: "退换货政策",
    content: `退换货政策说明：\n\n1. 自收到商品之日起7天内，可以申请无理由退货。商品需保持原包装完整，配件齐全，不影响二次销售。\n\n2. 如商品存在质量问题，自收到商品之日起15天内可以申请换货或退货。需提供清晰的问题照片或视频作为凭证。\n\n3. 退货运费承担规则：因商品质量问题导致的退货，运费由商家承担。因个人原因退货，运费由买家承担。\n\n4. 退款处理时间：收到退回商品并确认无误后，1-3个工作日内原路退款到支付账户。\n\n5. 以下情况不支持退换货：已使用影响二次销售的商品、超过退换货期限、缺少原包装或配件。`,
  },
  {
    title: "物流配送说明",
    content: `物流配送说明：\n\n1. 全国包邮（港澳台及偏远地区除外），默认使用中通快递发货。偏远地区可能需要补运费差价。\n\n2. 下单后48小时内发货，节假日顺延。预售商品以商品页面标注的发货时间为准。\n\n3. 配送时效：一线城市1-2天，二线城市2-3天，三四线城市3-5天。具体以快递公司为准。\n\n4. 物流查询：发货后会短信通知快递单号，也可在订单详情页查看物流信息。\n\n5. 如遇到包裹丢失或破损，请在签收前检查，如有问题当场拒收并联系客服处理。`,
  },
  {
    title: "售后服务流程",
    content: `售后服务流程：\n\n1. 在线客服时间：工作日 9:00-18:00，周末 10:00-17:00。非工作时间可留言，客服上线后第一时间回复。\n\n2. 电话客服热线：400-123-4567，服务时间同在线客服。\n\n3. 售后问题处理流程：提交问题 → 客服审核（1小时内响应） → 确定解决方案 → 执行处理。\n\n4. 投诉建议：如对服务不满意，可发送邮件至 feedback@example.com，我们会在24小时内回复。\n\n5. 常见问题可先查阅帮助中心，大部分问题都可以自助解决，无需等待客服。`,
  },
  {
    title: "会员权益说明",
    content: `会员权益说明：\n\n普通会员：注册即享，享受积分累积（消费1元=1积分），积分可兑换优惠券。\n\n银卡会员：年消费满2000元自动升级，享受9.5折优惠、专属客服通道、生日双倍积分。\n\n金卡会员：年消费满5000元自动升级，享受9折优惠、免运费、优先发货、专属礼品包装。\n\n钻石会员：年消费满10000元自动升级，享受8.5折优惠、专属顾问1对1服务、新品优先体验、线下活动邀请。\n\n会员等级有效期为1年，到期后根据上一年消费重新评定等级。`,
  },
  {
    title: "支付方式说明",
    content: `支付方式说明：\n\n1. 支持的支付方式：微信支付、支付宝、银行卡（储蓄卡/信用卡）、Apple Pay。\n\n2. 分期付款：单笔订单满500元可申请分期，支持3期、6期、12期，部分银行支持免息分期。\n\n3. 优惠券使用：在下单页面选择可用优惠券，可与部分促销活动叠加使用。部分限时折扣商品不支持优惠券。\n\n4. 支付安全：所有支付均通过PCI-DSS认证的第三方支付平台处理，我们不会保存您的银行卡信息。\n\n5. 支付遇到问题：如支付失败，请检查银行卡余额和限额，或尝试更换支付方式。仍无法解决请联系客服。`,
  },
];

// 种子函数：启动时检查并创建默认知识库 + 5 篇 FAQ
export async function seedKnowledgeBase(): Promise<string> {
  // 幂等检查：已存在则跳过
  const existing = await prisma.knowledgeBase.findUnique({
    where: { id: DEFAULT_KB_ID },
  });
  if (existing) {
    logger.info("Knowledge base seed data already exists, skipping");
    return DEFAULT_KB_ID;
  }

  // 创建知识库记录
  await prisma.knowledgeBase.create({
    data: {
      id: DEFAULT_KB_ID,
      name: "客服FAQ知识库",
      description:
        "默认客服常见问题知识库，包含退换货、物流、售后、会员、支付等FAQ",
    },
  });

  // 检查 embedding provider 是否可用
  const provider = getDefaultEmbeddingProvider();
  if (!provider) {
    logger.info(
      "No embedding provider configured, skipping document vectorization",
    );
    return DEFAULT_KB_ID;
  }

  // 批量摄取 FAQ 文档
  logger.info(
    { count: SAMPLE_FAQS.length },
    "Ingesting sample FAQ documents...",
  );
  try {
    const ingestion = new KnowledgeIngestionService();
    await ingestion.batchIngest(DEFAULT_KB_ID, SAMPLE_FAQS);
    logger.info(
      { kbId: DEFAULT_KB_ID, docs: SAMPLE_FAQS.length },
      "Seed data created",
    );
  } catch (e) {
    logger.warn(
      e,
      "Seed data vectorization failed (Milvus may not be running)",
    );
  }

  return DEFAULT_KB_ID;
}
