// Hono 应用工厂 —— 组装中间件和路由，创建完整的 HTTP 应用实例
// 使用工厂函数而非全局 app，方便测试（每个测试可创建独立实例）
import { Hono } from "hono";
import { corsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error.js";
import { chatRoutes } from "./routes/chat.js";
import { conversationRoutes } from "./routes/conversations.js";
import { providerRoutes } from "./routes/providers.js";
import { memoryRoutes } from "./routes/memories.js";
import { customerChatRoutes } from "./routes/customer-chat.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { toolRoutes } from "./routes/tools.js";

export function createApp() {
  const app = new Hono();

  // 全局中间件：CORS 应用于所有路径
  app.use("*", corsMiddleware);
  // 全局错误处理：所有未捕获异常在此统一返回 JSON
  app.onError(errorHandler);

  // 健康检查端点
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  // 注册所有业务路由（每个路由模块内部定义各自的路径前缀）
  app.route("/", chatRoutes);           // /api/chat, /api/conversations/:id/messages
  app.route("/", conversationRoutes);    // /api/conversations CRUD
  app.route("/", providerRoutes);        // /api/providers
  app.route("/", memoryRoutes);          // /api/memories, /api/memories/search
  app.route("/", customerChatRoutes);    // /api/customer-chat
  app.route("/", knowledgeRoutes);       // /api/knowledge/*
  app.route("/", toolRoutes);            // /api/tools

  return app;
}
