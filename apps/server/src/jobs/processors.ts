// BullMQ job processors — extracted for testability
// These are imported by worker.ts to register with BullMQ Workers
import type { Job } from "bullmq";
import type {
  MemoryExtractionJobData,
  KnowledgeIngestionJobData,
} from "./queues.js";
import { logger } from "@agentforge/logger";

/**
 * Process a memory extraction job.
 * Called by the worker — extracts memories from conversation messages
 * and stores them via MemoryService (Mem0 → PG+Milvus fallback).
 */
export async function processMemoryExtraction(
  job: Job<MemoryExtractionJobData>,
) {
  const { messages, userId, conversationId } = job.data;
  logger.info(
    { jobId: job.id, userId, messageCount: messages.length },
    "Processing memory extraction job",
  );

  // Dynamic import to avoid loading unnecessary server deps in worker
  const { getMemoryService } = await import("../services/memory-service.js");
  const memoryService = getMemoryService();
  const extracted = await memoryService.extractAndStore(
    messages,
    userId,
    conversationId,
  );

  logger.info(
    { jobId: job.id, extractedCount: extracted.length },
    "Memory extraction job complete",
  );
  return { extractedCount: extracted.length };
}

/**
 * Process a knowledge ingestion job.
 * Called by the worker — reads the pre-created KnowledgeDocument,
 * chunks the content, generates embeddings, and writes to Milvus + PostgreSQL.
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
