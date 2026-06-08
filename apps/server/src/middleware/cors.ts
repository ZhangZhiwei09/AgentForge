// CORS 中间件 —— 允许前端开发服务器跨域访问后端 API
import { cors } from "hono/cors";

export const corsMiddleware = cors({
  // 5173 = Vite 前端，3000 = 备用端口
  origin: ["http://localhost:5173", "http://localhost:3000"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
});
