// 应用入口 —— 启动服务器、连接数据库、初始化种子数据
import { serve } from "@hono/node-server";
import type { Server } from "http";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { createApp } from "./app.js";
import { settings } from "./config.js";
import { prisma } from "./db.js";
import { logger } from "@agentforge/logger";
import { authService } from "./services/auth.js";
import { initTracing } from "./observability/tracing.js";

// Dev seed: ensure default users exist with known passwords
// In production, users register via /api/auth/signup
async function seedDefaultUsers() {
  try {
    await authService.signUp("default@agentforge.local", "agentforge");
    logger.info("Default user seeded (default@agentforge.local / agentforge)");
  } catch {
    // Already exists — that's fine
  }

  try {
    await authService.signUp("customer@agentforge.local", "agentforge");
    logger.info("Customer user seeded");
  } catch {
    // Already exists
  }
}

async function main() {
  // 第零步：初始化可观测性（条件启用，OTEL_ENABLED=true 时生效）
  initTracing();

  // 第一步：检查数据库连接
  try {
    await prisma.$connect();
    logger.info("PostgreSQL connected");
  } catch (err) {
    logger.error(err, "Failed to connect to PostgreSQL");
    process.exit(1);
  }

  // 第二步：插入种子数据（用户、客服 FAQ 知识库）
  await seedDefaultUsers();

  try {
    const { seedKnowledgeBase } =
      await import("./services/knowledge-ingestion.js");
    await seedKnowledgeBase();
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : "Unknown error" },
      "Knowledge base seeding skipped",
    );
  }

  // 检查并构建倒排索引（已有 chunk 但无索引时自动重建）
  try {
    const chunkCount = await prisma.knowledgeChunk.count({
      where: { enabled: true },
    });
    const indexCount = await prisma.knowledgeInvertedIndex.count();
    if (chunkCount > 0 && indexCount === 0) {
      logger.info(
        { chunks: chunkCount },
        "Building initial inverted index for existing chunks",
      );
      const { KnowledgeIngestionService } =
        await import("./services/knowledge-ingestion.js");
      await KnowledgeIngestionService.rebuildInvertedIndex();
    }
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : "Unknown error" },
      "Inverted index build skipped",
    );
  }

  // 第三步：创建 Hono 应用并启动 HTTP 服务
  const app = await createApp();

  logger.info({ port: settings.port }, "AgentForge TS backend starting");
  const httpServer = serve({
    fetch: app.fetch,
    port: settings.port,
  }) as Server;

  // WebSocket upgrades handled at the HTTP server level to avoid double-write:
  // Hono route handlers call wss.handleUpgrade → writes 101 to raw socket,
  // then Hono adapter writes another 101 → "Invalid frame header".
  // server.on('upgrade') fires before Hono, so no duplicate response.
  setupWebSocketUpgrades(httpServer);

  logger.info({ port: settings.port }, "Server listening");
}

// ---- WebSocket Upgrade Handler (server-level, no Hono response cycle) ----

async function setupWebSocketUpgrades(httpServer: Server): Promise<void> {
  httpServer.on(
    "upgrade",
    (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = new URL(
        request.url || "/",
        `http://${request.headers.host || "localhost"}`,
      );

      // Other WebSocket paths (/api/voice/stream, /api/video/stream) are
      // handled by their respective Hono routes. Destroy the socket so
      // the Hono handler can pick it up via the normal request flow.
      socket.destroy();
    },
  );
}

// 顶层 await 包装：用 .catch 兜底未捕获错误
main().catch((err) => {
  logger.fatal(err, "Fatal error — exiting");
  process.exit(1);
});
