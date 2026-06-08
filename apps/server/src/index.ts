// 应用入口 —— 启动服务器、连接数据库、初始化种子数据
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { settings } from "./config.js";
import { prisma } from "./db.js";

// 单用户 MVP：所有数据挂在这两个固定用户下
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";  // 普通聊天用户
const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";  // 客服会话用户

// 确保默认用户存在（幂等：已存在则跳过）
async function seedDefaultUsers() {
  const defaultUser = await prisma.user.findUnique({
    where: { id: DEFAULT_USER_ID },
  });
  if (!defaultUser) {
    await prisma.user.create({
      data: {
        id: DEFAULT_USER_ID,
        email: "default@agentforge.local",
      },
    });
    console.log("[seed] Created default user:", DEFAULT_USER_ID);
  }

  const customerUser = await prisma.user.findUnique({
    where: { id: CUSTOMER_USER_ID },
  });
  if (!customerUser) {
    await prisma.user.create({
      data: {
        id: CUSTOMER_USER_ID,
        email: "customer@agentforge.local",
      },
    });
    console.log("[seed] Created customer user:", CUSTOMER_USER_ID);
  }
}

async function main() {
  // 第一步：检查数据库连接
  try {
    await prisma.$connect();
    console.log("[db] PostgreSQL connected");
  } catch (err) {
    console.error("[db] Failed to connect to PostgreSQL:", err);
    process.exit(1);
  }

  // 第二步：插入种子数据（用户、客服 FAQ 知识库）
  await seedDefaultUsers();

  try {
    const { seedKnowledgeBase } = await import("./services/knowledge-ingestion.js");
    await seedKnowledgeBase();
  } catch (err) {
    console.warn("[seed] Knowledge base seeding skipped:", (err as Error).message);
  }

  // 第三步：创建 Hono 应用并启动 HTTP 服务
  const app = createApp();

  console.log(`[server] AgentForge TS backend starting on http://localhost:${settings.port}`);
  serve({
    fetch: app.fetch,       // Hono 的 fetch 方法直接适配 node-server
    port: settings.port,
  });

  console.log(`[server] Listening on port ${settings.port}`);
}

// 顶层 await 包装：用 .catch 兜底未捕获错误
main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
