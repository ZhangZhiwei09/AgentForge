// Structured logging with request context injection via AsyncLocalStorage
import pino from "pino";
import { AsyncLocalStorage } from "node:async_hooks";

// ---- Request context ----

export interface RequestContext {
  requestId: string;
  userId?: string;
}

const contextStore = new AsyncLocalStorage<RequestContext>();

/** Get the current request context (returns undefined outside of a request) */
export function getRequestContext(): RequestContext | undefined {
  return contextStore.getStore();
}

/** Run a callback within a request context — used by request-id middleware */
export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T,
): T {
  return contextStore.run(ctx, fn);
}

// ---- Logger ----

function createLogger() {
  const isDev = process.env.NODE_ENV !== "production";

  return pino({
    level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
    ...(isDev && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
    }),
    mixin() {
      const ctx = getRequestContext();
      return ctx ? { reqId: ctx.requestId, userId: ctx.userId } : {};
    },
  });
}

// Singleton logger — imported by all modules
export const logger = createLogger();

// Re-export type for convenience
export type { Logger } from "pino";
