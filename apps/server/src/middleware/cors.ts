// CORS 中间件 —— 允许前端跨域访问后端 API
// 开发环境默认允许 localhost 常用端口，生产环境通过 CORS_ORIGINS 环境变量配置
import { cors } from "hono/cors";

function buildOriginList(): string[] {
  const envOrigins = process.env.CORS_ORIGINS;
  if (envOrigins) {
    // 逗号分隔的 origin 列表，例如：
    //   CORS_ORIGINS=https://cs.example.com,https://admin.example.com
    return envOrigins
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 开发环境默认：Vite, Next.js, 通用 localhost
  if (process.env.DEBUG === "true" || !process.env.CORS_ORIGINS) {
    return [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:5175",
      "http://localhost:3000",
      "http://localhost:3001",
    ];
  }

  // 生产环境未配置 CORS_ORIGINS 时的保守回退
  return [];
}

export const corsMiddleware = cors({
  origin: buildOriginList(),
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400, // 预检请求缓存 24 小时
});
