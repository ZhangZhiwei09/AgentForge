// Typed Hono factory — all routes should use this instead of bare `new Hono()`
// This ensures c.get("user") and c.set("user", ...) are properly typed
import { Hono } from "hono";
import type { AppVariables } from "../app.js";

export function createHono() {
  return new Hono<{ Variables: AppVariables }>();
}
