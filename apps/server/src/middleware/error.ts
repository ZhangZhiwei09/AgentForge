import type { Context } from "hono";

export function errorHandler(err: Error, c: Context) {
  console.error("[error]", err.message);
  const status = (err as { status?: number }).status || 500;
  return c.json(
    { detail: err.message || "Internal Server Error" },
    status as 200 | 400 | 401 | 403 | 404 | 500
  );
}
