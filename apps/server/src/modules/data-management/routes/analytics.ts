// 数据分析路由 —— 满意度评价 / FAQ / 反馈管理 / 统计
// 从 routes/agent-runtime.ts 提取，URL 路径保持不变
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "crypto";
import { prisma } from "../../../db.js";
import { IntentDetector } from "../../../services/intent-detector.js";
import { logger } from "@agentforge/logger";
import { createHono } from "../../../lib/hono.js";

export const analyticsRoutes = createHono();

// ════════════════════════════════════════════════════════════════
// 满意度评价
// ════════════════════════════════════════════════════════════════

const rateSchema = z.object({
  session_id: z.string().min(1),
  message_id: z.string().optional(),
  rating: z.string().min(1),
  comment: z.string().optional(),
});

// POST /api/agent/chat/rate
analyticsRoutes.post(
  "/api/agent/chat/rate",
  zValidator("json", rateSchema),
  async (c) => {
    const { session_id, message_id, rating, comment } = c.req.valid("json");

    const conversation = await prisma.conversation.findFirst({
      where: { sessionId: session_id, type: "agent_chat" },
    });

    if (!conversation) {
      return c.json({ detail: "会话不存在" }, 404);
    }

    try {
      await prisma.satisfactionRating.create({
        data: {
          id: randomUUID(),
          conversationId: conversation.id,
          messageId: message_id || null,
          rating,
          comment: comment || null,
        },
      });
    } catch {
      logger.warn("satisfaction_ratings table may not exist yet");
    }

    return c.json({ status: "ok", rating });
  },
);

// ════════════════════════════════════════════════════════════════
// FAQ / 帮助中心
// ════════════════════════════════════════════════════════════════

// GET /api/agent/chat/faq
analyticsRoutes.get("/api/agent/chat/faq", async (c) => {
  const category = c.req.query("category");
  const kb = await prisma.knowledgeBase.findFirst({
    where: { name: { contains: "客服" } },
  });

  if (!kb) {
    return c.json({ documents: [] });
  }

  const where: Record<string, unknown> = {
    knowledgeBaseId: kb.id,
    status: "completed",
  };

  const docs = await prisma.knowledgeDocument.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      chunkCount: true,
      status: true,
      createdAt: true,
    },
  });

  let filtered = docs;
  if (category) {
    filtered = docs.filter((d) => d.title.includes(category));
  }

  return c.json({ documents: filtered });
});

// GET /api/agent/chat/faq/categories
analyticsRoutes.get("/api/agent/chat/faq/categories", async (c) => {
  const intentDetectorInst = new IntentDetector();
  const intents = intentDetectorInst.listIntents();

  const kb = await prisma.knowledgeBase.findFirst({
    where: { name: { contains: "客服" } },
  });

  const categories = await Promise.all(
    intents.map(async (intent) => {
      let count = 0;
      if (kb) {
        count = await prisma.knowledgeDocument.count({
          where: {
            knowledgeBaseId: kb.id,
            status: "completed",
            title: { contains: intent.slice(0, 2) },
          },
        });
      }
      return { name: intent, count };
    }),
  );

  return c.json({ categories });
});

// GET /api/agent/chat/faq/:docId
analyticsRoutes.get("/api/agent/chat/faq/:docId", async (c) => {
  const docId = c.req.param("docId");
  if (!docId) {
    return c.json({ detail: "缺少文档 ID" }, 400);
  }

  try {
    const doc = await prisma.knowledgeDocument.findUnique({
      where: { id: docId },
      include: {
        chunks: {
          orderBy: { chunkIndex: "asc" },
          take: 1,
        },
      },
    });

    if (!doc) {
      return c.json({ detail: "文档不存在" }, 404);
    }

    return c.json({
      id: doc.id,
      title: doc.title,
      content: doc.chunks[0]?.content?.slice(0, 500) || "",
      chunkCount: doc.chunkCount,
      status: doc.status,
    });
  } catch (err) {
    logger.error(
      { docId, error: err instanceof Error ? err.message : "Unknown error" },
      "FAQ detail fetch error",
    );
    return c.json({ detail: "获取文档失败" }, 500);
  }
});

// ════════════════════════════════════════════════════════════════
// 反馈管理
// ════════════════════════════════════════════════════════════════

// GET /api/agent/chat/feedback
analyticsRoutes.get("/api/agent/chat/feedback", async (c) => {
  const feedbackType = c.req.query("type") || "all";
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);

  try {
    let ratingFilter = "";
    if (feedbackType === "negative") {
      ratingFilter = `AND (sr.rating = 'negative' OR sr.rating LIKE 'star_%')`;
    } else if (feedbackType === "positive") {
      ratingFilter = `AND sr.rating = 'positive'`;
    }

    const feedback = await prisma.$queryRawUnsafe<
      Array<{
        id: string;
        rating: string;
        comment: string | null;
        created_at: string;
        conversation_id: string;
        session_id: string;
        intent: string | null;
        user_message: string;
        assistant_message: string;
        message_id: string;
      }>
    >(
      `SELECT
        sr.id,
        sr.rating,
        sr.comment,
        sr.created_at::text AS created_at,
        c.id AS conversation_id,
        c.session_id,
        c.intent,
        um.content AS user_message,
        am.content AS assistant_message,
        COALESCE(sr.message_id, am.id) AS message_id
      FROM satisfaction_ratings sr
      JOIN conversations c ON c.id = sr.conversation_id
      LEFT JOIN messages am ON am.id = sr.message_id AND am.role = 'assistant'
      LEFT JOIN LATERAL (
        SELECT m.content FROM messages m
        WHERE m.conversation_id = c.id
          AND m.role = 'user'
          AND m.created_at < sr.created_at
        ORDER BY m.created_at DESC
        LIMIT 1
      ) um ON true
      WHERE c.type = 'agent_chat'
        ${ratingFilter}
      ORDER BY sr.created_at DESC
      LIMIT $1 OFFSET $2`,
      limit,
      (page - 1) * limit,
    );

    const countResult = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) as count
       FROM satisfaction_ratings sr
       JOIN conversations c ON c.id = sr.conversation_id
       WHERE c.type = 'agent_chat' ${ratingFilter}`,
    );
    const total = Number(countResult[0]?.count ?? 0);

    return c.json({
      feedback: feedback.map((f) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        created_at: f.created_at,
        conversation_id: f.conversation_id,
        session_id: f.session_id,
        intent: f.intent,
        user_message: f.user_message?.slice(0, 200) || "",
        assistant_message: f.assistant_message?.slice(0, 300) || "",
        message_id: f.message_id,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (e) {
    logger.error(e, "Feedback query failed");
    return c.json({
      feedback: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
    });
  }
});

// ════════════════════════════════════════════════════════════════
// 统计
// ════════════════════════════════════════════════════════════════

// GET /api/agent/chat/analytics
analyticsRoutes.get("/api/agent/chat/analytics", async (c) => {
  try {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );

    const totalConversations = await prisma.conversation.count({
      where: { type: "agent_chat" },
    });

    const todayConversations = await prisma.conversation.count({
      where: {
        type: "agent_chat",
        createdAt: { gte: todayStart },
      },
    });

    const totalMessages = await prisma.message.count({
      where: {
        conversation: { type: "agent_chat" },
      },
    });

    let satisfactionRate = 0;
    let totalRatings = 0;
    try {
      const ratings = await prisma.$queryRawUnsafe<
        Array<{ count: bigint; rating: string }>
      >(
        `SELECT COUNT(*)::int as count, rating FROM satisfaction_ratings GROUP BY rating`,
      );
      if (Array.isArray(ratings)) {
        totalRatings = ratings.reduce((sum, r) => sum + Number(r.count), 0);
        const positive = ratings
          .filter(
            (r) =>
              r.rating === "positive" ||
              r.rating?.startsWith("star_4") ||
              r.rating?.startsWith("star_5"),
          )
          .reduce((sum, r) => sum + Number(r.count), 0);
        satisfactionRate =
          totalRatings > 0 ? Math.round((positive / totalRatings) * 100) : 0;
      }
    } catch {
      // 表可能不存在
    }

    return c.json({
      total_conversations: totalConversations,
      today_conversations: todayConversations,
      total_messages: totalMessages,
      satisfaction_rate: satisfactionRate,
      total_ratings: totalRatings,
    });
  } catch (e) {
    logger.error(e, "Analytics query failed");
    return c.json({
      total_conversations: 0,
      today_conversations: 0,
      total_messages: 0,
      satisfaction_rate: 0,
      total_ratings: 0,
    });
  }
});
