// 全局错误处理中间件单元测试
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

// ═══════════════════════════════════════════════════════
// Mock：Logger（需要验证 logger.error 被调用）
// ═══════════════════════════════════════════════════════

const { mockLoggerError } = vi.hoisted(() => {
  const mockLoggerError = vi.fn();
  return { mockLoggerError };
});

vi.mock("@agentforge/logger", () => ({
  logger: {
    error: mockLoggerError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// ═══════════════════════════════════════════════════════
// 导入受测模块（必须在 vi.mock 之后）
// ═══════════════════════════════════════════════════════

import { errorHandler } from "../error.js";

describe("errorHandler", () => {
  // 模拟 Hono Context 的 json 方法，捕获调用参数
  const mockJson = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // json 返回一个简单的标记值，方便验证 errorHandler 确实调用了 c.json
    mockJson.mockReturnValue(new Response('{"mocked":"json"}'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 创建模拟的 Hono Context 对象。
   * errorHandler 只使用了 c.json，因此只模拟该方法。
   */
  function createMockContext(): Context {
    return { json: mockJson } as unknown as Context;
  }

  // ── 辅助：提取传给 c.json 的参数 ──
  function getJsonCallArgs() {
    expect(mockJson).toHaveBeenCalled();
    const [body, status] = mockJson.mock.calls[0] as [
      Record<string, unknown>,
      number | undefined,
    ];
    return { body, status };
  }

  // ═══════════════════════════════════════════════════════
  // HTTPException 场景
  // ═══════════════════════════════════════════════════════

  it("Hono HTTPException with status 400 returns {detail, status: 400}", () => {
    const err = new HTTPException(400, { message: "Bad Request" });
    const c = createMockContext();

    errorHandler(err, c);

    const { body, status } = getJsonCallArgs();
    expect(body.detail).toBe("Bad Request");
    expect(status).toBe(400);
  });

  it("Hono HTTPException with status 404 returns status 404", () => {
    const err = new HTTPException(404, { message: "Not Found" });
    const c = createMockContext();

    errorHandler(err, c);

    const { status } = getJsonCallArgs();
    expect(status).toBe(404);
  });

  it("Hono HTTPException with status 500 returns status 500", () => {
    const err = new HTTPException(500, { message: "Server Error" });
    const c = createMockContext();

    errorHandler(err, c);

    const { status } = getJsonCallArgs();
    expect(status).toBe(500);
  });

  // ═══════════════════════════════════════════════════════
  // Generic Error 场景（非 HTTPException）
  // ═══════════════════════════════════════════════════════

  it("Generic Error (not HTTPException) returns status 500", () => {
    const err = new Error("Something broke");
    const c = createMockContext();

    errorHandler(err, c);

    const { body, status } = getJsonCallArgs();
    expect(status).toBe(500);
    expect(body.detail).toBe("Something broke");
  });

  it("Error with empty message returns 'Internal Server Error' as detail", () => {
    const err = new Error("");
    const c = createMockContext();

    errorHandler(err, c);

    const { body } = getJsonCallArgs();
    expect(body.detail).toBe("Internal Server Error");
  });

  it("Error with a message includes that message in the detail field", () => {
    const err = new Error("Database connection lost");
    const c = createMockContext();

    errorHandler(err, c);

    const { body } = getJsonCallArgs();
    expect(body.detail).toBe("Database connection lost");
  });

  // ═══════════════════════════════════════════════════════
  // Response 格式
  // ═══════════════════════════════════════════════════════

  it("response body is a JSON object with only a detail field", () => {
    const err = new Error("test");
    const c = createMockContext();

    errorHandler(err, c);

    const { body } = getJsonCallArgs();
    // body 应该是一个对象，且只有 detail 字段
    expect(body).toStrictEqual({ detail: "test" });
    expect(Object.keys(body)).toHaveLength(1);
    expect(Object.keys(body)).toEqual(["detail"]);
  });

  // ═══════════════════════════════════════════════════════
  // Logger 调用验证
  // ═══════════════════════════════════════════════════════

  it("logger.error is called for every error", () => {
    const err = new Error("logged error");
    const c = createMockContext();

    errorHandler(err, c);

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledWith(
      err,
      "Unhandled request error",
    );
  });

  it("logger.error receives the original error object as first argument", () => {
    const err = new HTTPException(403, { message: "Forbidden" });
    const c = createMockContext();

    errorHandler(err, c);

    expect(mockLoggerError).toHaveBeenCalledWith(
      err,
      "Unhandled request error",
    );
  });

  // ═══════════════════════════════════════════════════════
  // 安全性：栈信息不泄露
  // ═══════════════════════════════════════════════════════

  it("stack trace is NOT leaked to the response body", () => {
    const err = new Error("secret internal failure");
    // 确保错误有 stack 信息
    expect(err.stack).toBeTruthy();
    const c = createMockContext();

    errorHandler(err, c);

    const { body } = getJsonCallArgs();
    // 响应中不应该有 stack 属性
    expect(body).not.toHaveProperty("stack");
    // 响应中不应该有 stackTrace 属性
    expect(body).not.toHaveProperty("stackTrace");
    // detail 字段不应该包含 stack trace 内容
    expect(body.detail).not.toContain("at ");
    expect(body.detail).not.toContain("errorHandler");
  });
});
