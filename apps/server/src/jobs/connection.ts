// BullMQ Redis connection singleton — follows the same factory pattern as rate-limit-store.ts
// Uses a separate ioredis instance from the rate-limit store (BullMQ requires maxRetriesPerRequest: null)
import IORedis from "ioredis";
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";

let _connection: IORedis | null = null;
let _connectionFailed = false;

export function getRedisConnection(): IORedis | null {
  if (_connection) return _connection;
  if (_connectionFailed) return null;

  try {
    _connection = new IORedis(settings.redisUrl, {
      maxRetriesPerRequest: null, // Required by BullMQ — it handles retries internally
      enableReadyCheck: false,
      lazyConnect: true,
    });
    logger.info({ url: settings.redisUrl }, "BullMQ Redis connection created");
    return _connection;
  } catch (err) {
    _connectionFailed = true;
    logger.warn({ err, url: settings.redisUrl }, "Redis unavailable — BullMQ queues disabled (jobs will run synchronously)");
    return null;
  }
}

/** For testing: reset connection state */
export function _resetConnection(): void {
  _connection = null;
  _connectionFailed = false;
}
