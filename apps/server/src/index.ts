// 应用入口 —— 启动服务器、连接数据库、初始化种子数据
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { settings } from "./config.js";
import { prisma } from "./db.js";
import { logger } from "@agentforge/logger";
import { authService } from "./services/auth.js";

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
    const { seedKnowledgeBase } = await import("./services/knowledge-ingestion.js");
    await seedKnowledgeBase();
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "Knowledge base seeding skipped");
  }

  // 预热BM25索引（最佳effort，失败不影响服务启动）
  try {
    const { KnowledgeService } = await import("./services/knowledge.js");
    const ks = new KnowledgeService();
    await ks.warmupAll();
  } catch (err) {
    logger.warn({ error: (err as Error).message }, "BM25 warmup skipped");
  }

  // 第三步：创建 Hono 应用并启动 HTTP 服务
  const app = createApp();

  logger.info({ port: settings.port }, "AgentForge TS backend starting");
  serve({
    fetch: app.fetch,       // Hono 的 fetch 方法直接适配 node-server
    port: settings.port,
  });

  logger.info({ port: settings.port }, "Server listening");
}

// 顶层 await 包装：用 .catch 兜底未捕获错误
main().catch((err) => {
  logger.fatal(err, "Fatal error — exiting");
  process.exit(1);
});
