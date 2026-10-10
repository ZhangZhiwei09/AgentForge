// Hono 应用工厂 —— 组装中间件和路由，创建完整的 HTTP 应用实例
// 使用工厂函数而非全局 app，方便测试（每个测试可创建独立实例）
import { Hono } from "hono";
import { metricsMiddleware } from "./middleware/metrics.js";
import { corsMiddleware } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { authMiddleware } from "./middleware/auth.js";
import { globalRateLimiter } from "./middleware/rate-limit.js";
import { contentSafetyMiddleware } from "./middleware/content-safety.js";
import { authRoutes } from "./routes/auth.js";
import { agentRuntimeRoutes } from "./routes/agent-runtime.js";
import { toolRoutes } from "./routes/tools.js";
import { diagnosisRoutes } from "./routes/diagnosis.js";
import { agentRoutes } from "./routes/agent.js";
import { workflowRoutes } from "./routes/workflows.js";
import { teamRoutes } from "./routes/teams.js";
import { agentFlowRoutes } from "./routes/agent-flows.js";
import { entryRouteFlowRoutes } from "./routes/entry-route-flows.js";
import { debugDiagnosisRoutes } from "./routes/debug-diagnosis.js";
import { healthRoutes } from "./routes/health.js";
import { registerMetricsEndpoint } from "./observability/metrics.js";
import { dataManagementModule } from "./modules/data-management/index.js";
import type { ServerModule } from "./modules/types.js";
import type { AuthUser } from "@agentforge/shared-types";

// Hono context variables — all middleware and routes share this type
export type AppVariables = {
  user: AuthUser;
  requestId: string;
};

export async function createApp() {
  const app = new Hono<{ Variables: AppVariables }>();

  // 全局中间件：指标采集（排第一，确保所有请求都被计数）
  app.use("*", metricsMiddleware);
  // 全局中间件：请求 ID 追踪（优先于 CORS，确保所有日志都有 reqId）
  app.use("*", requestIdMiddleware);
  // 全局中间件：CORS 应用于所有路径
  app.use("*", corsMiddleware);
  // 全局中间件：认证验证（白名单跳过 auth routes、health、agent chat）
  app.use("*", authMiddleware);
  // 全局中间件：速率限制
  app.use("*", globalRateLimiter);
  // 内容安全检测（防止 prompt injection 和超长消息）
  app.use("/api/agent/chat", contentSafetyMiddleware);
  // 全局错误处理：所有未捕获异常在此统一返回 JSON
  app.onError(errorHandler);

  // 健康检查端点
  app.get("/api/health", (c) => c.json({ status: "ok" }));

  // Readiness 端点（DB + Redis + Provider 连通性）
  app.route("/", healthRoutes);

  // Prometheus 指标端点 — 注册在 auth 中间件应用的同一层级
  // （metricsMiddleware 本身捕捉了所有请求，但 /api/metrics 自身需要显式路由）
  registerMetricsEndpoint(app);

  // 注册共享基础设施路由
  app.route("/", authRoutes);         // /api/auth/* (public)
  app.route("/", agentRuntimeRoutes); // /api/agent/chat, /api/agent/chat/history
  app.route("/", toolRoutes);         // /api/tools
  app.route("/", diagnosisRoutes);    // /api/diagnosis/query
  app.route("/", agentRoutes);        // /api/agent/*, /api/agent-sessions/*
  app.route("/", workflowRoutes);     // /api/workflows/*, /api/workflows/runs/*
  app.route("/", teamRoutes);         // /api/teams/*, /api/teams/runs/*
  app.route("/", agentFlowRoutes);    // configuration API forwarded to Python
  app.route("/", entryRouteFlowRoutes);
  app.route("/", debugDiagnosisRoutes); // /debug/diagnosis (public debug page)

  // 注册业务模块路由（可插拔：设置 enabled: false 即可禁用整个模块）
  const modules: ServerModule[] = [
    dataManagementModule, // /api/knowledge/*, /api/memories/*, /api/agent/chat/rate|faq|feedback|analytics
  ];
  for (const mod of modules) {
    if (mod.enabled !== false) {
      app.route("/", mod.routes);
      if (mod.onInit) await mod.onInit();
    }
  }

  // P1-1 Bull Board 监控面板 — 仅在 Redis 可用时挂载
  try {
    const { getBullBoardHandler } = await import("./jobs/bull-board.js");
    const handler = getBullBoardHandler();
    if (handler) {
      app.route("/admin/queues", handler as unknown as Parameters<typeof app.route>[1]);
    }
  } catch {
    // Bull Board not available (e.g., missing deps or Redis down) — skip gracefully
  }

  return app;
}
