// 客服聊天路由 —— POST /api/customer-chat 为匿名客服 SSE 端点
// 与 /api/chat 的主要区别：不需要 conversation_id（用 session_id），不注入记忆
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { CustomerChatService } from "../services/customer-chat.js";
import { createHono } from "../lib/hono.js";

export const customerChatRoutes = createHono();

const customerChatRequestSchema = z.object({
  session_id: z.string().nullable().optional(), // null 则新建会话
  message: z.string().min(1),
});

// POST /api/customer-chat —— 匿名客服 SSE 流式端点
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
