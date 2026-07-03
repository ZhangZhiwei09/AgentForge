// BullMQ job processors — extracted for testability
// These are imported by worker.ts to register with BullMQ Workers
import type { Job } from "bullmq";
import type {
  MemoryExtractionJobData,
  KnowledgeIngestionJobData,
} from "./queues.js";
import { logger } from "@agentforge/logger";

/**
 * Process a memory extraction job（长期记忆已移除，no-op）。
 * 保留函数签名以维持 API 兼容性，不再执行实际提取逻辑。
 */
export async function processMemoryExtraction(
  job: Job<MemoryExtractionJobData>,
) {
  logger.info(
    { jobId: job.id, userId: job.data.userId },
    "Memory extraction job skipped（长期记忆已移除，no-op）",
  );
  return { extractedCount: 0 };
}

/**
 * Process a knowledge ingestion job.
 * Called by the worker — reads the pre-created KnowledgeDocument,
 * chunks the content, generates embeddings, and writes to PostgreSQL.
 */
export async function processKnowledgeIngestion(
  job: Job<KnowledgeIngestionJobData>,
) {
  const { docId, kbId } = job.data;
  logger.info({ jobId: job.id, docId }, "Processing knowledge ingestion job");

  // Dynamic import to avoid loading full server at parse time
  const { KnowledgeIngestionService } =
    await import("../services/knowledge-ingestion.js");
  const ingestion = new KnowledgeIngestionService();
  await ingestion.processExistingDocument(docId, kbId);

  logger.info({ jobId: job.id, docId }, "Knowledge ingestion job complete");
  return { docId, status: "completed" };
}
