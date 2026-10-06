// Agent Runtime 路由 —— POST /api/agent/chat 为 Agent SSE 端点
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getAgentRuntimeService } from "../services/agent-runtime.js";
import { prisma } from "../db.js";
import { createHono } from "../lib/hono.js";
import { authService } from "../services/auth.js";

export const agentRuntimeRoutes = createHono();

const agentChatRequestSchema = z.object({
  session_id: z.string().nullable().optional(),
  conversation_id: z.string().optional(),
  message: z.string().min(1),
});

// POST /api/agent/chat —— Agent SSE 流式端点
agentRuntimeRoutes.post(
  "/api/agent/chat",
  zValidator("json", agentChatRequestSchema),
  async (c) => {
    const { session_id, conversation_id, message } = c.req.valid("json");
    // conversation_id 优先（新前端），fallback 到 session_id（旧兼容）
    const lookupId = conversation_id || (session_id ?? null);

    // 提取用户 ID：优先验证 token，未认证时从 JWT payload 解码 sub，回退到系统用户
    const authHeader = c.req.header("Authorization")?.replace("Bearer ", "");
    let userId = "00000000-0000-0000-0000-000000000002";
    if (authHeader) {
      const user = await authService.validateToken(authHeader);
      if (user) {
        userId = user.id;
      } else {
        // Token 验证失败时，尝试直接解码 JWT payload 提取 sub（不验证签名）
        try {
          const parts = authHeader.split(".");
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
            if (payload.sub) userId = payload.sub;
          }
        } catch {
          // 解码失败则保持系统用户 ID
        }
      }
    }

    const service = getAgentRuntimeService();

    return streamSSE(c, async (stream) => {
      try {
        for await (const chunk of service.streamChat(
          lookupId,
          userId,
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

// GET /api/agent/chat/history?conversation_id=X  (也兼容旧参数 session_id)
agentRuntimeRoutes.get("/api/agent/chat/history", async (c) => {
  const lookupId = c.req.query("conversation_id") || c.req.query("session_id");
  if (!lookupId) {
    return c.json({ detail: "缺少 conversation_id 参数" }, 400);
  }

  // 优先按主键查找，fallback 到 sessionId（旧数据兼容）
  let conversation = await prisma.conversation.findUnique({
    where: { id: lookupId },
  });
  if (!conversation) {
    conversation = await prisma.conversation.findFirst({
      where: { sessionId: lookupId, type: "agent_chat" },
    });
  }

  if (!conversation) {
    return c.json({ messages: [] });
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      type: true,
      content: true,
      createdAt: true,
      // metadata 承载引用卡片与过程时间轴，历史回放需要
      metadata: true,
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
      type: m.type,
      content: m.content,
      timestamp: m.createdAt,
      metadata: m.metadata,
    })),
  });
});

// ════════════════════════════════════════════════════════════════
// 会话列表（ChatGPT 风格侧边栏）
// ════════════════════════════════════════════════════════════════

// GET /api/agent/chat/conversations
// - 已认证用户：返回该用户所有 agent_chat 会话
// - 匿名用户：通过 ?session_id= 返回单个会话
agentRuntimeRoutes.get("/api/agent/chat/conversations", async (c) => {
  const sessionId = c.req.query("session_id");

  // 尝试从 Authorization header 提取用户（验证失败时直接解码 payload）
  const authHeader = c.req.header("Authorization")?.replace("Bearer ", "");
  if (authHeader) {
    let user = await authService.validateToken(authHeader);
    if (!user) {
      // Token 过期或签名不匹配时，直接解码 JWT payload 提取 sub
      try {
        const parts = authHeader.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
          if (payload.sub) user = { id: payload.sub, email: payload.email ?? "", role: payload.role ?? "user" };
        }
      } catch {
        // 解码失败则忽略
      }
    }
    if (user) {
      const conversations = await prisma.conversation.findMany({
        where: { userId: user.id, type: "agent_chat" },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          sessionId: true,
          createdAt: true,
          updatedAt: true,
          messages: {
            take: 1,
            orderBy: { createdAt: "asc" },
            select: { content: true },
          },
        },
      });

      return c.json({
        conversations: conversations.map((conv) => ({
          id: conv.id,
          title: conv.title,
          session_id: conv.sessionId,
          created_at: conv.createdAt,
          updated_at: conv.updatedAt,
          first_message: conv.messages[0]?.content?.slice(0, 100) ?? null,
        })),
      });
    }
  }

  // 匿名用户：通过 session_id 查找
  if (!sessionId) {
    return c.json({ conversations: [] });
  }

  const conv = await prisma.conversation.findFirst({
    where: { sessionId, type: "agent_chat" },
    select: {
      id: true,
      title: true,
      sessionId: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        take: 1,
        orderBy: { createdAt: "asc" },
        select: { content: true },
      },
    },
  });

  return c.json({
    conversations: conv
      ? [
          {
            id: conv.id,
            title: conv.title,
            session_id: conv.sessionId,
            created_at: conv.createdAt,
            updated_at: conv.updatedAt,
            first_message: conv.messages[0]?.content?.slice(0, 100) ?? null,
          },
        ]
      : [],
  });
});

// DELETE /api/agent/chat/conversations/:id
// 需要认证：验证用户拥有该会话
agentRuntimeRoutes.delete("/api/agent/chat/conversations/:id", async (c) => {
  const convId = c.req.param("id");

  // 认证检查
  const authHeader = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!authHeader) {
    return c.json({ detail: "需要登录才能删除会话" }, 401);
  }

  const user = await authService.validateToken(authHeader);
  if (!user) {
    return c.json({ detail: "认证已过期，请重新登录" }, 401);
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: convId },
  });

  if (!conversation) {
    return c.json({ detail: "会话不存在" }, 404);
  }

  if (conversation.userId !== user.id) {
    return c.json({ detail: "无权删除此会话" }, 403);
  }

  await prisma.conversation.delete({ where: { id: convId } });

  return c.json({ ok: true });
});

// 注意: 满意度评价、FAQ、反馈管理、统计分析端点已迁移至
// modules/data-management/routes/analytics.ts，URL 路径保持不变
