// 应用入口 —— 启动服务器、连接数据库、初始化种子数据
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { settings } from "./config.js";
import { prisma } from "./db.js";
import { logger } from "@agentforge/logger";
import { authService } from "./services/auth.js";
import { initTracing } from "./observability/tracing.js";
import {
  initObservability,
  shutdownObservability,
} from "./observability/index.js";

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
  // 第零步：初始化可观测性（条件启用，OTEL_ENABLED=true / LANGFUSE_ENABLED=true 时生效）
  initTracing();
  initObservability();

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

  // 第三步：创建 Hono 应用并启动 HTTP 服务
  const app = await createApp();

  logger.info({ port: settings.port }, "AgentForge TS backend starting");
  const httpServer = serve({
    fetch: app.fetch,
    port: settings.port,
  });

  logger.info({ port: settings.port }, "Server listening");

  // 优雅关闭：依次断开外部依赖，等待进行中请求完成
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, "Received shutdown signal, starting graceful shutdown...");

    // 1. 停止接受新连接，等待进行中请求完成（最多 10s）
    const SHUTDOWN_TIMEOUT_MS = 10_000;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
      httpServer.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    // 2. 断开数据库连接
    try {
      await prisma.$disconnect();
      logger.info("Prisma disconnected");
    } catch (err) {
      logger.warn(err, "Failed to disconnect Prisma");
    }

    // 3. Flush 可观测性数据
    try {
      await shutdownObservability();
      logger.info("Observability shutdown complete");
    } catch (err) {
      logger.warn(err, "Failed to shutdown observability");
    }

    logger.info("Graceful shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

// 顶层 await 包装：用 .catch 兜底未捕获错误
main().catch((err) => {
  logger.fatal(err, "Fatal error — exiting");
  process.exit(1);
});
