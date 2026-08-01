// Auth routes — sign up, sign in, refresh, me, API key management
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { authService } from "../services/auth.js";
import { createHono } from "../lib/hono.js";

export const authRoutes = createHono();

const signUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

const apiKeySchema = z.object({
  name: z.string().min(1).max(100),
});

// POST /api/auth/signup
authRoutes.post(
  "/api/auth/signup",
  zValidator("json", signUpSchema),
  async (c) => {
    try {
      const { email, password } = c.req.valid("json");
      const result = await authService.signUp(email, password);
      return c.json(result, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return c.json({ detail: msg }, 400);
    }
  },
);

// POST /api/auth/signin
authRoutes.post(
  "/api/auth/signin",
  zValidator("json", signInSchema),
  async (c) => {
    try {
      const { email, password } = c.req.valid("json");
      const result = await authService.signIn(email, password);
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return c.json({ detail: msg }, 401);
    }
  },
);

// POST /api/auth/refresh
authRoutes.post(
  "/api/auth/refresh",
  zValidator("json", refreshSchema),
  async (c) => {
    try {
      const { refresh_token } = c.req.valid("json");
      const result = await authService.refreshAccessToken(refresh_token);
      return c.json(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return c.json({ detail: msg }, 401);
    }
  },
);

// POST /api/auth/signout
authRoutes.post("/api/auth/signout", async (c) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (token) {
    await authService.revokeRefreshToken(token).catch(() => {});
  }
  return c.json({ status: "ok" });
});

// GET /api/auth/me — requires auth middleware
authRoutes.get("/api/auth/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ detail: "Unauthorized" }, 401);
  return c.json(user);
});

// POST /api/auth/api-keys — create API key
authRoutes.post(
  "/api/auth/api-keys",
  zValidator("json", apiKeySchema),
  async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ detail: "Unauthorized" }, 401);

    const { name } = c.req.valid("json");
    const result = await authService.createApiKey(user.id, name);
    return c.json(result, 201);
  },
);

// GET /api/auth/api-keys — list API keys
authRoutes.get("/api/auth/api-keys", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ detail: "Unauthorized" }, 401);

  const keys = await authService.listApiKeys(user.id);
  return c.json(keys);
});

// DELETE /api/auth/api-keys/:id — revoke API key
authRoutes.delete("/api/auth/api-keys/:id", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ detail: "Unauthorized" }, 401);

  const keyId = c.req.param("id");
  const revoked = await authService.revokeApiKey(user.id, keyId);
  if (!revoked) {
    return c.json({ detail: "API key not found" }, 404);
  }
  return c.json({ status: "revoked" });
});
