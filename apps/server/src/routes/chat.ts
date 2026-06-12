// 聊天路由 —— POST /api/chat 为核心 SSE 流式端点
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ChatService } from "../services/chat.js";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import { createHono } from "../lib/hono.js";
import { verifyConversationOwnership } from "../lib/conversation-guard.js";

export const chatRoutes = createHono();

// 请求体校验：对话 ID + 消息文本 + 可选模型 + 可选工具 + 可选知识库
const chatRequestSchema = z.object({
  conversation_id: z.string(),
  message: z
    .string()
    .min(1)
    .max(16000, "Message must be at most 16000 characters"),
  model: z.string().nullable().optional(),
  kb_ids: z.array(z.string()).nullable().optional(), // 可选：限定使用的知识库
  tools: z.array(z.string()).nullable().optional(), // 可选：启用的工具名称列表
});

// POST /api/chat —— 核心 SSE 流式聊天端点
// 流程：校验所有权 → 创建 ChatService → 流式转发 LLM 响应 → SSE 格式输出
chatRoutes.post(
  "/api/chat",
  zValidator("json", chatRequestSchema),
  async (c) => {
    const { conversation_id, message, model, kb_ids, tools } =
      c.req.valid("json");
    const user = c.get("user");

    if (!(await verifyConversationOwnership(conversation_id, user.id))) {
      return c.json({ detail: "Conversation not found or access denied" }, 404);
    }

    const service = new ChatService();

    logger.info(
      {
        conversationId: conversation_id,
        model,
        kbCount: kb_ids?.length ?? 0,
        toolCount: tools?.length ?? 0,
      },
      "Chat request",
    );

    // Hono SSE 流式响应：通过 stream.writeSSE 逐片发送
    return streamSSE(c, async (stream) => {
      try {
        for await (const chunk of service.streamChat(
          conversation_id,
          message,
          model,
          undefined,
          kb_ids ?? null,
          tools ?? null,
        )) {
          // 每个 chunk 序列化为 JSON，格式：data: {json}\n\n
          await stream.writeSSE({ data: JSON.stringify(chunk) });
        }
        // 流结束标记（前端 SDK 以此判断流正常结束）
        await stream.writeSSE({ data: "[DONE]" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        await stream.writeSSE({
          data: JSON.stringify({ type: "error", content: errMsg }),
        });
      }
    });
  },
);

// GET /api/conversations/:id/messages —— 获取对话的所有消息
chatRoutes.get("/api/conversations/:id/messages", async (c) => {
  const conversationId = c.req.param("id");
  const user = c.get("user");

  if (!(await verifyConversationOwnership(conversationId, user.id))) {
    return c.json({ detail: "Conversation not found or access denied" }, 404);
  }

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });

  return c.json(messages);
});
