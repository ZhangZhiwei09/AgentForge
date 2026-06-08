// 全局错误处理中间件 —— 捕获所有未处理的异常，统一返回 JSON 错误响应
import type { Context } from "hono";

export function errorHandler(err: Error, c: Context) {
  console.error("[error]", err.message);
  // Hono 的 HTTPException 会带 status 属性，否则默认 500
  const status = (err as { status?: number }).status || 500;
  return c.json(
    { detail: err.message || "Internal Server Error" },
    status as 200 | 400 | 401 | 403 | 404 | 500
  );
}
