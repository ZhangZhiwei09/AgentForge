// Bull Board monitoring dashboard — conditionally mounted when queues are available
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { getIngestionQueue } from "./queues.js";

let _boardHandler: ReturnType<HonoAdapter["registerPlugin"]> | null = null;
let _initialized = false;

export function getBullBoardHandler() {
  if (_initialized) return _boardHandler;
  _initialized = true;

  const ingestionQueue = getIngestionQueue();

  if (!ingestionQueue) return null;

  const serverAdapter = new HonoAdapter(serveStatic);
  const queues = [new BullMQAdapter(ingestionQueue)];

  createBullBoard({ queues, serverAdapter });

  _boardHandler = serverAdapter.registerPlugin();
  return _boardHandler;
}
