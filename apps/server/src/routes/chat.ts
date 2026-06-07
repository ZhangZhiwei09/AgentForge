import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ChatService } from "../services/chat.js";
import { prisma } from "../db.js";

export const chatRoutes = new Hono();

const chatRequestSchema = z.object({
  conversation_id: z.string(),
  message: z.string().min(1),
  model: z.string().nullable().optional(),
});

// POST /api/chat — SSE streaming
chatRoutes.post("/api/chat", zValidator("json", chatRequestSchema), async (c) => {
  const { conversation_id, message, model } = c.req.valid("json");
  const service = new ChatService();

  console.log(`[chat] request={conversation_id: "${conversation_id}", message: "${message.slice(0, 50)}...", model: ${model}}`);

  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of service.streamChat(conversation_id, message, model)) {
        await stream.writeSSE({ data: JSON.stringify(chunk) });
      }
      await stream.writeSSE({ data: "[DONE]" });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      await stream.writeSSE({ data: JSON.stringify({ type: "error", content: errMsg }) });
    }
  });
});

// GET /api/conversations/:id/messages
chatRoutes.get("/api/conversations/:id/messages", async (c) => {
  const conversationId = c.req.param("id");

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });

  return c.json(messages);
});
