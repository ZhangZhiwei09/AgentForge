import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { CustomerChatService } from "../services/customer-chat.js";

export const customerChatRoutes = new Hono();

const customerChatRequestSchema = z.object({
  session_id: z.string().nullable().optional(),
  message: z.string().min(1),
});

// POST /api/customer-chat — SSE streaming
customerChatRoutes.post("/api/customer-chat", zValidator("json", customerChatRequestSchema), async (c) => {
  const { session_id, message } = c.req.valid("json");
  const service = new CustomerChatService();

  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of service.streamChat(session_id ?? null, message)) {
        await stream.writeSSE({ data: JSON.stringify(chunk) });
      }
      await stream.writeSSE({ data: "[DONE]" });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "Unknown error";
      await stream.writeSSE({ data: JSON.stringify({ type: "error", content: errMsg }) });
    }
  });
});
