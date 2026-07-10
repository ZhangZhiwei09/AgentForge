// BullMQ job processors — extracted for testability
// These are imported by worker.ts to register with BullMQ Workers
import type { Job } from "bullmq";
import type { KnowledgeIngestionJobData } from "./queues.js";
import { logger } from "@agentforge/logger";

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
