import type { Hono } from "hono";

// ServerModule —— 每个业务模块的标准导出接口
// 模块通过此接口注册到 app.ts 的路由注册表
// routes 使用 Hono<any> 以兼容不同 Variables 泛型的 Hono 实例
export interface ServerModule {
  name: string;
  routes: Hono<any, any, any>;
  onInit?: () => Promise<void>;
  enabled?: boolean;
}
