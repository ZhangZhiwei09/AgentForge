// BullMQ queue definitions with typed job data
// Lazy singleton factory — returns null when Redis is unavailable (caller falls back to sync)
import { Queue } from "bullmq";
import { getRedisConnection } from "./connection.js";

// ---- Job Data Types ----

export interface KnowledgeIngestionJobData {
  docId: string;
  kbId: string;
}

// ---- Queue Names ----

export const KNOWLEDGE_INGESTION_QUEUE = "knowledge-ingestion";

// ---- Queue Lazy Singletons ----

// Use a symbol to distinguish "not yet initialized" from "initialized as null (Redis down)"
const UNINITIALIZED = Symbol("uninitialized");

let _ingestionQueue:
  | Queue<KnowledgeIngestionJobData>
  | null
  | typeof UNINITIALIZED = UNINITIALIZED;

function createQueue<T>(name: string): Queue<T> | null {
  const connection = getRedisConnection();
  if (!connection) return null;
  try {
    return new Queue<T>(name, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    });
  } catch {
    // Expected: Redis may be unavailable — jobs will be processed once Redis is up
    return null;
  }
}

export function getIngestionQueue(): Queue<KnowledgeIngestionJobData> | null {
  if (_ingestionQueue === UNINITIALIZED) {
    _ingestionQueue = createQueue<KnowledgeIngestionJobData>(
      KNOWLEDGE_INGESTION_QUEUE,
    );
  }
  return _ingestionQueue as Queue<KnowledgeIngestionJobData> | null;
}

/** For testing: reset queue instances */
export function _resetQueues(): void {
  _ingestionQueue = UNINITIALIZED;
}
