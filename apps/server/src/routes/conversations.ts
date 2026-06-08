// 对话管理路由 —— /api/conversations CRUD
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../db.js";

export const conversationRoutes = new Hono();

// 单用户 MVP：所有对话挂在此用户下
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

const createConversationSchema = z.object({
  title: z.string().optional(), // 可选标题，默认 "New Conversation"
});

// POST /api/conversations —— 创建新对话
conversationRoutes.post("/api/conversations", zValidator("json", createConversationSchema), async (c) => {
  const { title } = c.req.valid("json");

  const conv = await prisma.conversation.create({
    data: {
      id: randomUUID(),
      title: title || "New Conversation",
      userId: DEFAULT_USER_ID,
    },
  });

  return c.json(conv, 201);
});

// GET /api/conversations —— 获取当前用户的所有对话（按更新时间倒序）
conversationRoutes.get("/api/conversations", async (c) => {
  const conversations = await prisma.conversation.findMany({
    where: { userId: DEFAULT_USER_ID },
    orderBy: { updatedAt: "desc" },
  });

  return c.json(conversations);
});

// GET /api/conversations/:id —— 获取单个对话详情
conversationRoutes.get("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const conv = await prisma.conversation.findUnique({ where: { id } });

  if (!conv) {
    return c.json({ detail: "Conversation not found" }, 404);
  }

  return c.json(conv);
});

// DELETE /api/conversations/:id —— 删除对话（CASCADE 自动清理关联消息）
conversationRoutes.delete("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const conv = await prisma.conversation.findUnique({ where: { id } });

  if (!conv) {
    return c.json({ detail: "Conversation not found" }, 404);
  }

  await prisma.conversation.delete({ where: { id } });

  return c.body(null, 204);
});
