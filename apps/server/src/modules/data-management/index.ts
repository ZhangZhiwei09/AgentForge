// Data Management 模块入口 —— 导出标准 ServerModule 接口
import type { ServerModule } from "../types.js";
import { knowledgeManagementRoutes } from "./routes/knowledge.js";
import { knowledgeRegressionRoutes } from "./routes/regression.js";
import { memoryManagementRoutes } from "./routes/memories.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { createHono } from "../../lib/hono.js";

// 将三个子路由合并为一个 Hono 实例（使用 createHono 确保 Variables 类型一致）
const mergedRoutes = createHono();
mergedRoutes.route("/", knowledgeManagementRoutes);
mergedRoutes.route("/", knowledgeRegressionRoutes);
mergedRoutes.route("/", memoryManagementRoutes);
mergedRoutes.route("/", analyticsRoutes);

export const dataManagementModule: ServerModule = {
  name: "data-management",
  routes: mergedRoutes,
};
