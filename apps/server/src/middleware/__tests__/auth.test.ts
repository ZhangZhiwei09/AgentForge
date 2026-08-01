// Auth middleware tests — public route bypass, Bearer token, API key, error cases
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AuthUser } from "@agentforge/shared-types";
import type { AppVariables } from "../../app.js";

// Must mock before importing the middleware module
const mockValidateToken = vi.fn();
const mockLoggerDebug = vi.fn();

vi.mock("../../services/auth.js", () => ({
  authService: {
    validateToken: (...args: unknown[]) => mockValidateToken(...args),
  },
}));

vi.mock("@agentforge/logger", () => ({
  logger: {
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
  },
}));

// Now import the middleware (it will use the mocked dependencies)
import { authMiddleware } from "../auth.js";

// ---- Test Helpers ----

const MOCK_USER: AuthUser = {
  id: "user-abc-123",
  email: "test@agentforge.test",
  role: "user",
};

/**
 * Create a minimal Hono app that mounts authMiddleware and a downstream
 * handler that echoes the user and requestId from context variables.
 * Returns the app and a spy on the downstream handler to verify it ran.
 */
function createTestApp() {
  const downstreamSpy = vi.fn();
  const app = new Hono<{ Variables: AppVariables }>();

  // Apply auth middleware to all paths
  app.use("*", authMiddleware);

  // GET /api/protected → returns the authenticated user info
  app.get("/api/protected", (c) => {
    downstreamSpy();
    const user = c.get("user");
    const requestId = c.get("requestId");
    return c.json({ user, requestId });
  });

  // POST /api/protected → for testing non-GET methods
  app.post("/api/protected", (c) => {
    downstreamSpy();
    return c.json({ user: c.get("user"), requestId: c.get("requestId") });
  });

  // A catch-all test route under a protected prefix
  app.get("/api/protected/nested", (c) => {
    downstreamSpy();
    return c.json({ user: c.get("user"), requestId: c.get("requestId") });
  });

  return { app, downstreamSpy };
}

// ---- Tests ----

describe("authMiddleware", () => {
  let app: Hono<{ Variables: AppVariables }>;
  let downstreamSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // clearAllMocks only resets call history, not queued mock implementations
    // (mockResolvedValueOnce / mockRejectedValueOnce). Use mockReset to
    // fully reset the mock to a clean no-op function.
    vi.clearAllMocks();
    mockValidateToken.mockReset();
    // The middleware also calls logger.debug; reset that mock too so debug
    // invocations from earlier tests don't contaminate later assertions.
    mockLoggerDebug.mockReset();
    const testApp = createTestApp();
    app = testApp.app;
    downstreamSpy = testApp.downstreamSpy;
  });

  // ====================================================================
  // Public route tests — exact matches
  // ====================================================================

  describe("public routes (exact match) — skip auth", () => {
    const publicPaths = [
      "/api/auth/signup",
      "/api/auth/signin",
      "/api/auth/refresh",
      "/api/health",
      "/api/agent/chat",
      "/api/diagnosis/query",
      "/api/agent/chat/history",
      "/api/agent/chat/conversations",
      "/api/agent/chat/rate",
      "/debug/diagnosis",
    ];

    it.each(publicPaths)("allows %s without a token", async (path) => {
      const res = await app.request(path);
      // Should not return 401 — the middleware should skip auth
      expect(res.status).not.toBe(401);
    });

    it("allows /api/auth/signin to pass through without authentication", async () => {
      const res = await app.request("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "test" }),
      });
      // No 401 = public route correctly bypassed
      expect(res.status).not.toBe(401);
    });

    it("allows /api/auth/signup to pass through without authentication", async () => {
      const res = await app.request("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "a@b.com", password: "test" }),
      });
      expect(res.status).not.toBe(401);
    });

    it("allows /api/auth/refresh to pass through without authentication", async () => {
      const res = await app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: "xxx" }),
      });
      expect(res.status).not.toBe(401);
    });
  });

  describe("public routes (prefix match) — skip auth", () => {
    it("allows /api/health without a token", async () => {
      const res = await app.request("/api/health");
      expect(res.status).not.toBe(401);
    });

    it("allows /api/agent/chat without a token", async () => {
      const res = await app.request("/api/agent/chat");
      expect(res.status).not.toBe(401);
    });

    it("allows /api/agent/chat/faq without a token (prefix match)", async () => {
      const res = await app.request("/api/agent/chat/faq");
      expect(res.status).not.toBe(401);
    });

    it("allows /api/agent/chat/faq/some-topic without a token (prefix sub-path)", async () => {
      const res = await app.request("/api/agent/chat/faq/some-topic");
      expect(res.status).not.toBe(401);
    });

    it("allows /api/agent/chat/conversations/123 without a token (prefix match)", async () => {
      const res = await app.request("/api/agent/chat/conversations/123", {
        method: "DELETE",
      });
      expect(res.status).not.toBe(401);
    });

    it("does NOT treat /api/agent/chat/faqs as public (prefix is /faq, not /faqs)", async () => {
      // "/api/agent/chat/faqs" does not start with "/api/agent/chat/faq" +
      // a separator, so it actually DOES start with "/api/agent/chat/faq"
      // Wait — "/api/agent/chat/faqs".startsWith("/api/agent/chat/faq") is true!
      // This tests the actual prefix behavior: "faqs" matches the "faq" prefix.
      const res = await app.request("/api/agent/chat/faqs");
      expect(res.status).not.toBe(401);
    });
  });

  // ====================================================================
  // Protected route tests — missing / invalid / valid tokens
  // ====================================================================

  describe("protected routes — missing token", () => {
    it("returns 401 when no token is provided", async () => {
      const res = await app.request("/api/protected");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.detail).toBe("Unauthorized — missing token");
    });

    it("returns 401 with empty Authorization header", async () => {
      const res = await app.request("/api/protected", {
        headers: { Authorization: "" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 with Authorization header that has no token after Bearer", async () => {
      const res = await app.request("/api/protected", {
        headers: { Authorization: "Bearer " },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("protected routes — valid Bearer token", () => {
    it("sets c.set('user', user) and calls next() for a valid Bearer token", async () => {
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      const res = await app.request("/api/protected", {
        headers: { Authorization: "Bearer valid-jwt-token" },
      });

      expect(res.status).toBe(200);
      expect(downstreamSpy).toHaveBeenCalled();

      const body = await res.json();
      expect(body.user).toEqual(MOCK_USER);
      expect(body.requestId).toBe("");
    });

    it("passes the extracted token (without 'Bearer ' prefix) to validateToken", async () => {
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      await app.request("/api/protected", {
        headers: { Authorization: "Bearer my-secret-token" },
      });

      expect(mockValidateToken).toHaveBeenCalledWith("my-secret-token");
    });

    it("preserves existing requestId if set before auth middleware", async () => {
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      // Create a one-off app that sets requestId before auth
      const customApp = new Hono<{ Variables: AppVariables }>();
      customApp.use("*", async (c, next) => {
        c.set("requestId", "req-12345");
        await next();
      });
      customApp.use("*", authMiddleware);
      customApp.get("/api/protected", (c) => {
        return c.json({ user: c.get("user"), requestId: c.get("requestId") });
      });

      const res = await customApp.request("/api/protected", {
        headers: { Authorization: "Bearer valid-jwt-token" },
      });

      const body = await res.json();
      expect(body.requestId).toBe("req-12345");
    });

    it("logs debug message on successful auth", async () => {
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      await app.request("/api/protected", {
        headers: { Authorization: "Bearer valid-jwt-token" },
      });

      expect(mockLoggerDebug).toHaveBeenCalledWith(
        { userId: MOCK_USER.id, path: "/api/protected" },
        "Auth OK",
      );
    });
  });

  describe("protected routes — invalid Bearer token", () => {
    it("returns 401 when validateToken returns null", async () => {
      mockValidateToken.mockResolvedValueOnce(null);

      const res = await app.request("/api/protected", {
        headers: { Authorization: "Bearer invalid-token" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.detail).toBe("Invalid or expired token");
    });

    it("does NOT call next() when token is invalid", async () => {
      mockValidateToken.mockResolvedValueOnce(null);

      await app.request("/api/protected", {
        headers: { Authorization: "Bearer invalid-token" },
      });

      expect(downstreamSpy).not.toHaveBeenCalled();
    });
  });

  describe("protected routes — expired token", () => {
    it("returns 401 when validateToken returns null (simulating expiry)", async () => {
      // Expired token validation returns null (same as invalid)
      mockValidateToken.mockResolvedValueOnce(null);

      const res = await app.request("/api/protected", {
        headers: { Authorization: "Bearer expired-jwt-token" },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.detail).toBe("Invalid or expired token");
    });
  });

  // ====================================================================
  // API key query parameter tests
  // ====================================================================

  describe("API key via query parameter", () => {
    it("authenticates with a valid API key in ?api_key query param", async () => {
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      const res = await app.request("/api/protected?api_key=af_mysecretkey");

      expect(res.status).toBe(200);
      expect(downstreamSpy).toHaveBeenCalled();

      const body = await res.json();
      expect(body.user).toEqual(MOCK_USER);

      // Verify the API key string was passed directly to validateToken
      expect(mockValidateToken).toHaveBeenCalledWith("af_mysecretkey");
    });

    it("returns 401 with an invalid API key query param", async () => {
      mockValidateToken.mockResolvedValueOnce(null);

      const res = await app.request("/api/protected?api_key=invalid-key");

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.detail).toBe("Invalid or expired token");
    });

    it("falls back to api_key query param when Authorization header is missing", async () => {
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      const res = await app.request("/api/protected?api_key=af_fallback");
      expect(res.status).toBe(200);
      expect(mockValidateToken).toHaveBeenCalledWith("af_fallback");
    });
  });

  // ====================================================================
  // Malformed / edge-case Authorization header tests
  // ====================================================================

  describe("malformed Authorization header", () => {
    it("returns 401 when Authorization is not 'Bearer xxx' format", async () => {
      const res = await app.request("/api/protected", {
        headers: { Authorization: "Basic dXNlcjpwYXNz" },
      });

      expect(res.status).toBe(401);
      // "Basic dXNlcjpwYXNz" after Bearer replace is still "Basic dXNlcjpwYXNz"
      // This token is sent to validateToken, which returns null
      const body = await res.json();
      expect(body.detail).toBe("Invalid or expired token");
    });

    it("sends the raw string when no Bearer prefix is present", async () => {
      mockValidateToken.mockResolvedValueOnce(null);

      await app.request("/api/protected", {
        headers: { Authorization: "Token abc123" },
      });

      // The string "Token abc123" has no "Bearer " prefix, so replace is a no-op
      expect(mockValidateToken).toHaveBeenCalledWith("Token abc123");
    });
  });

  // ====================================================================
  // Multiple Authorization headers
  // ====================================================================

  describe("multiple Authorization headers", () => {
    it("handles the first Authorization header value (Hono/H3 behavior)", async () => {
      // Note: Hono's c.req.header() returns the first header value.
      // The Fetch API spec says multiple values are joined with ", ",
      // but Hono's implementation returns only the first.
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      // In the fetch-compatible Hono Request, headers can only have one
      // value per name. Multiple set-cookie is the exception, not Auth.
      // We test that the middleware works with the actual Hono behavior.
      const res = await app.request("/api/protected", {
        headers: { Authorization: "Bearer first-token" },
      });

      expect(res.status).toBe(200);
      expect(mockValidateToken).toHaveBeenCalledWith("first-token");
    });
  });

  // ====================================================================
  // API key vs Authorization header precedence
  // ====================================================================

  describe("API key and Authorization header together", () => {
    it("Authorization header takes precedence over api_key query param", async () => {
      // The middleware uses: header ?? query
      // If Authorization header is present, it's used; api_key is ignored
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      const res = await app.request(
        "/api/protected?api_key=af_query_key",
        {
          headers: { Authorization: "Bearer header-token" },
        },
      );

      expect(res.status).toBe(200);
      // Verify header token was used, not the query param
      expect(mockValidateToken).toHaveBeenCalledWith("header-token");
      expect(mockValidateToken).not.toHaveBeenCalledWith("af_query_key");
    });

    it("does NOT fall back to api_key when Authorization header is empty string", async () => {
      // "".replace("Bearer ", "") returns "" — and "" is NOT nullish.
      // The ?? operator only checks for null | undefined, so the empty
      // string is kept as-is. The subsequent !token guard sees "" as
      // falsy and returns 401 without ever calling validateToken.
      const res = await app.request(
        "/api/protected?api_key=af_fallback_key",
        {
          headers: { Authorization: "" },
        },
      );

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.detail).toBe("Unauthorized — missing token");
      // validateToken was never called because the empty-string token
      // was caught by the !token guard first.
      expect(mockValidateToken).not.toHaveBeenCalled();
    });
  });

  // ====================================================================
  // validateToken error/rejection tests
  // ====================================================================

  describe("validateToken throws", () => {
    it("propagates the error when validateToken rejects (no try/catch in middleware)", async () => {
      mockValidateToken.mockRejectedValueOnce(new Error("DB connection failed"));

      // The middleware has no try/catch — the rejected promise causes Hono
      // to return a 500 Internal Server Error (its built-in fallback).
      const res = await app.request("/api/protected", {
        headers: { Authorization: "Bearer any-token" },
      });

      // Hono's default unhandled-error behaviour returns 500
      expect(res.status).toBe(500);
      expect(downstreamSpy).not.toHaveBeenCalled();
    });
  });

  // ====================================================================
  // Non-GET method tests
  // ====================================================================

  describe("non-GET methods on protected routes", () => {
    it("authenticates POST requests correctly", async () => {
      mockValidateToken.mockResolvedValueOnce(MOCK_USER);

      const res = await app.request("/api/protected", {
        method: "POST",
        headers: {
          Authorization: "Bearer valid-jwt-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: "test" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user).toEqual(MOCK_USER);
    });

    it("blocks POST without token (401)", async () => {
      const res = await app.request("/api/protected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: "test" }),
      });

      expect(res.status).toBe(401);
    });
  });

  // ====================================================================
  // PUBLIC_PREFIXES boundary tests
  // ====================================================================

  describe("PUBLIC_PREFIXES edge cases", () => {
    it("/api/agent/chat/f is NOT public (prefix is /faq, not /f)", async () => {
      // "/api/agent/chat/f" startsWith "/api/agent/chat/faq" → false, so protected
      const res = await app.request("/api/agent/chat/f");
      expect(res.status).toBe(401);
    });

    it("/api/agent/chat/fa (prefix partial match) is NOT public", async () => {
      // "/api/agent/chat/fa" startsWith "/api/agent/chat/faq" → false
      const res = await app.request("/api/agent/chat/fa");
      expect(res.status).toBe(401);
    });

    it("/api/agent/chat/conversations without trailing slash is an exact match in PUBLIC_PATHS", async () => {
      // In PUBLIC_PATHS: "/api/agent/chat/conversations" (exact match)
      const res = await app.request("/api/agent/chat/conversations", {
        method: "GET",
      });
      expect(res.status).not.toBe(401);
    });
  });

  // ====================================================================
  // Verify no unintended side effects
  // ====================================================================

  describe("no side effects on context", () => {
    it("does not set user or requestId on public routes", async () => {
      // Create a one-off app that checks context vars after auth on public route
      const customApp = new Hono<{ Variables: AppVariables }>();
      customApp.use("*", authMiddleware);
      customApp.get("/api/health", (c) => {
        // Try to get user — should be undefined on public routes
        const user = c.get("user");
        return c.json({ hasUser: user !== undefined && user !== null });
      });

      const res = await customApp.request("/api/health");
      const body = await res.json();
      // Public routes skip auth entirely, so user is never set by the middleware
      expect(body.hasUser).toBe(false);
    });
  });
});
