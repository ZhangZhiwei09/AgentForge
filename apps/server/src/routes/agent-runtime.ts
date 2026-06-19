// Agent Runtime 路由 —— POST /api/agent/chat 为 Agent SSE 端点
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getAgentRuntimeService } from "../services/agent-runtime.js";
import { prisma } from "../db.js";
import { createHono } from "../lib/hono.js";

export const agentRuntimeRoutes = createHono();

const agentChatRequestSchema = z.object({
  session_id: z.string().nullable().optional(),
  message: z.string().min(1),
});

// POST /api/agent/chat —— Agent SSE 流式端点
agentRuntimeRoutes.post(
  "/api/agent/chat",
  zValidator("json", agentChatRequestSchema),
  async (c) => {
    const { session_id, message } = c.req.valid("json");
    const service = getAgentRuntimeService();

    return streamSSE(c, async (stream) => {
      try {
        for await (const chunk of service.streamChat(
          session_id ?? null,
          message,
          c.req.raw.signal,
        )) {
          await stream.writeSSE({ data: JSON.stringify(chunk) });
        }
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

// ════════════════════════════════════════════════════════════════
// 会话历史
// ════════════════════════════════════════════════════════════════

// GET /api/agent/chat/history?session_id=X
agentRuntimeRoutes.get("/api/agent/chat/history", async (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) {
    return c.json({ detail: "缺少 session_id 参数" }, 400);
  }

  const conversation = await prisma.conversation.findFirst({
    where: { sessionId, type: "agent_chat" },
  });

  if (!conversation) {
    return c.json({ messages: [] });
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      content: true,
      createdAt: true,
    },
  });

  return c.json({
    conversation_id: conversation.id,
    session_id: conversation.sessionId,
    created_at: conversation.createdAt,
    intent: conversation.intent,
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.createdAt,
    })),
  });
});

// 注意: 满意度评价、FAQ、反馈管理、统计分析端点已迁移至
// modules/data-management/routes/analytics.ts，URL 路径保持不变
