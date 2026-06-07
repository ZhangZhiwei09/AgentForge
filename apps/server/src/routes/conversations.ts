import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../db.js";

export const conversationRoutes = new Hono();

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

const createConversationSchema = z.object({
  title: z.string().optional(),
});

// POST /api/conversations
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

// GET /api/conversations
conversationRoutes.get("/api/conversations", async (c) => {
  const conversations = await prisma.conversation.findMany({
    where: { userId: DEFAULT_USER_ID },
    orderBy: { updatedAt: "desc" },
  });

  return c.json(conversations);
});

// GET /api/conversations/:id
conversationRoutes.get("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const conv = await prisma.conversation.findUnique({ where: { id } });

  if (!conv) {
    return c.json({ detail: "Conversation not found" }, 404);
  }

  return c.json(conv);
});

// DELETE /api/conversations/:id
conversationRoutes.delete("/api/conversations/:id", async (c) => {
  const id = c.req.param("id");
  const conv = await prisma.conversation.findUnique({ where: { id } });

  if (!conv) {
    return c.json({ detail: "Conversation not found" }, 404);
  }

  await prisma.conversation.delete({ where: { id } });

  return c.body(null, 204);
});
