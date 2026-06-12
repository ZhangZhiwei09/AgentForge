// 全局错误处理中间件 —— 捕获所有未处理的异常，统一返回 JSON 错误响应
import type { ErrorHandler } from "hono";
import { logger } from "@agentforge/logger";
import type { AppVariables } from "../app.js";

export const errorHandler: ErrorHandler<{ Variables: AppVariables }> = (
  err,
  c,
) => {
  logger.error(err, "Unhandled request error");
  // Hono 的 HTTPException 会带 status 属性，否则默认 500
  const status = (err as { status?: number }).status || 500;
  return c.json(
    { detail: err.message || "Internal Server Error" },
    status as 200 | 400 | 401 | 403 | 404 | 500,
  );
};
