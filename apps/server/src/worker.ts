// BullMQ Worker Process — runs independently from the HTTP server
// Processes memory extraction and knowledge ingestion jobs from Redis queues
// Start with: pnpm server:worker
import { Worker, type Job } from "bullmq";
import { getRedisConnection } from "./jobs/connection.js";
import {
  MEMORY_EXTRACTION_QUEUE,
  KNOWLEDGE_INGESTION_QUEUE,
  type MemoryExtractionJobData,
  type KnowledgeIngestionJobData,
} from "./jobs/queues.js";
import {
  processMemoryExtraction,
  processKnowledgeIngestion,
} from "./jobs/processors.js";
import { logger } from "@agentforge/logger";

function startWorker() {
  const connection = getRedisConnection();
  if (!connection) {
    logger.error(
      "Cannot start worker: Redis connection is not available. Set REDIS_URL and ensure Redis is running.",
    );
    process.exit(1);
  }

  // Memory extraction worker
  const memoryWorker = new Worker<MemoryExtractionJobData>(
    MEMORY_EXTRACTION_QUEUE,
    processMemoryExtraction,
    {
      connection,
      concurrency: 1,
    },
  );

  // Knowledge ingestion worker
  const ingestionWorker = new Worker<KnowledgeIngestionJobData>(
    KNOWLEDGE_INGESTION_QUEUE,
    processKnowledgeIngestion,
    {
      connection,
      concurrency: 1,
    },
  );

  // --- Event handlers ---

  memoryWorker.on("completed", (job: Job) => {
    logger.info(
      { jobId: job.id, queue: MEMORY_EXTRACTION_QUEUE },
      "Job completed",
    );
  });

  memoryWorker.on("failed", (job: Job | undefined, err: Error) => {
    logger.error(
      { jobId: job?.id, queue: MEMORY_EXTRACTION_QUEUE, error: err.message },
      "Job failed",
    );
  });

  ingestionWorker.on("completed", (job: Job) => {
    logger.info(
      { jobId: job.id, queue: KNOWLEDGE_INGESTION_QUEUE },
      "Job completed",
    );
  });

  ingestionWorker.on("failed", async (job: Job | undefined, err: Error) => {
    logger.error(
      { jobId: job?.id, queue: KNOWLEDGE_INGESTION_QUEUE, error: err.message },
      "Job failed",
    );

    // If all retries exhausted, mark the knowledge document as failed
    if (job && job.attemptsMade >= ((job.opts?.attempts as number) ?? 1)) {
      try {
        const { prisma } = await import("./db.js");
        const data = job.data as KnowledgeIngestionJobData;
        await prisma.knowledgeDocument.update({
          where: { id: data.docId },
          data: { status: "failed" },
        });
        logger.warn(
          { docId: data.docId },
          "Knowledge document marked as failed after all retries exhausted",
        );
      } catch (e) {
        logger.error(
          { error: e instanceof Error ? e.message : "Unknown error" },
          "Failed to update document status",
        );
      }
    }
  });

  logger.info(
    "BullMQ worker started — listening on queues: memory-extraction, knowledge-ingestion",
  );
  logger.info("Press Ctrl+C to stop");
}

startWorker();
