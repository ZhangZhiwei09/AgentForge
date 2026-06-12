// 客服聊天路由 —— POST /api/customer-chat 为匿名客服 SSE 端点
// 与 /api/chat 的主要区别：不需要 conversation_id（用 session_id），不注入记忆
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "crypto";
import { CustomerChatService } from "../services/customer-chat.js";
import { IntentDetector } from "../services/intent-detector.js";
import { prisma } from "../db.js";
import { createHono } from "../lib/hono.js";
import { logger } from "@agentforge/logger";

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

// ════════════════════════════════════════════════════════════════
// 会话历史
// ════════════════════════════════════════════════════════════════

// GET /api/customer-chat/history?session_id=X —— 获取客户会话历史消息
customerChatRoutes.get("/api/customer-chat/history", async (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) {
    return c.json({ detail: "缺少 session_id 参数" }, 400);
  }

  const conversation = await prisma.conversation.findFirst({
    where: { sessionId, type: "customer_service" },
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

// ════════════════════════════════════════════════════════════════
// 满意度评价
// ════════════════════════════════════════════════════════════════

const rateSchema = z.object({
  session_id: z.string().min(1),
  message_id: z.string().optional(),
  rating: z.string().min(1), // 'positive', 'negative', 'star_1'..'star_5'
  comment: z.string().optional(),
});

// POST /api/customer-chat/rate —— 提交满意度评价
customerChatRoutes.post("/api/customer-chat/rate", zValidator("json", rateSchema), async (c) => {
  const { session_id, message_id, rating, comment } = c.req.valid("json");

  // 根据 session_id 查找会话
  const conversation = await prisma.conversation.findFirst({
    where: { sessionId: session_id, type: "customer_service" },
  });

  if (!conversation) {
    return c.json({ detail: "会话不存在" }, 404);
  }

  // 保存评价
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
    // 表可能还未创建，静默处理
    logger.warn("satisfaction_ratings table may not exist yet");
  }

  return c.json({ status: "ok", rating });
});

// ════════════════════════════════════════════════════════════════
// 反馈管理 —— 评价数据闭环：反哺知识库质量 + 客服运营
// ════════════════════════════════════════════════════════════════

// GET /api/customer-chat/feedback?type={all|negative|positive}&page=1&limit=20
// 获取带上下文的评价列表，用于管理后台审核
customerChatRoutes.get("/api/customer-chat/feedback", async (c) => {
  const feedbackType = c.req.query("type") || "all"; // all | negative | positive
  const page = parseInt(c.req.query("page") || "1", 10);
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);

  try {
    // 查询评价记录（带会话和消息上下文）
    let ratingFilter = "";
    const params: string[] = [];
    let paramIdx = 1;

    if (feedbackType === "negative") {
      ratingFilter = `AND (sr.rating = 'negative' OR sr.rating LIKE 'star_%')`;
    } else if (feedbackType === "positive") {
      ratingFilter = `AND sr.rating = 'positive'`;
    }

    // 获取评价列表
    const feedback = await prisma.$queryRawUnsafe<Array<{
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
    }>>(
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
      WHERE c.type = 'customer_service'
        ${ratingFilter}
      ORDER BY sr.created_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      ...params,
      limit,
      (page - 1) * limit,
    );

    // 获取总数
    const countResult = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) as count
       FROM satisfaction_ratings sr
       JOIN conversations c ON c.id = sr.conversation_id
       WHERE c.type = 'customer_service' ${ratingFilter}`,
    );
    const total = Number(countResult[0]?.count ?? 0);

    // 意图维度评价汇总：哪类问题的差评最多（独立 try-catch，失败不影响主列表）
    let intentPerformance: Array<{
      intent_name: string;
      total: number;
      positive: number;
      negative: number;
      health: number;
    }> = [];
    try {
      const rows = await prisma.$queryRawUnsafe<Array<{
        intent: string | null;
        total: bigint;
        positive: bigint;
        negative: bigint;
      }>>(
        `SELECT
          c.intent,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE sr.rating = 'positive') as positive,
          COUNT(*) FILTER (WHERE sr.rating = 'negative' OR sr.rating LIKE 'star_%') as negative
        FROM satisfaction_ratings sr
        JOIN conversations c ON c.id = sr.conversation_id
        WHERE c.type = 'customer_service'
        GROUP BY c.intent
        ORDER BY negative DESC, total DESC`,
      );
      intentPerformance = rows.map((r) => ({
        intent_name: r.intent || "未分类",
        total: Number(r.total),
        positive: Number(r.positive),
        negative: Number(r.negative),
        health: Number(r.total) > 0
          ? Math.round((Number(r.positive) / Number(r.total)) * 100)
          : 100,
      }));
    } catch {
      // 查询失败则返回空，不影响其他数据
    }

    // 趋势：最近7天每天的正/负评价数（独立 try-catch）
    let trends: Array<{ date: string; total: number; positive: number; negative: number }> = [];
    try {
      const trendRows = await prisma.$queryRawUnsafe<Array<{
        date: string;
        total: bigint;
        positive: bigint;
        negative: bigint;
      }>>(
        `SELECT
          sr.created_at::date::text AS date,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE sr.rating = 'positive') AS positive,
          COUNT(*) FILTER (WHERE sr.rating = 'negative' OR sr.rating LIKE 'star_%') AS negative
        FROM satisfaction_ratings sr
        JOIN conversations c ON c.id = sr.conversation_id
        WHERE c.type = 'customer_service'
          AND sr.created_at >= NOW() - INTERVAL '7 days'
        GROUP BY sr.created_at::date
        ORDER BY date DESC`,
      );
      trends = trendRows.map((t) => ({
        date: t.date,
        total: Number(t.total),
        positive: Number(t.positive),
        negative: Number(t.negative),
      }));
    } catch {
      // 查询失败则返回空
    }

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
      intent_performance: intentPerformance,
      trends,
    });
  } catch (e) {
    logger.error(e, "Feedback query failed");
    return c.json({
      feedback: [],
      pagination: { page, limit, total: 0, totalPages: 0 },
      faq_performance: [],
      trends: [],
    });
  }
});

// ════════════════════════════════════════════════════════════════
// FAQ / 帮助中心
// ════════════════════════════════════════════════════════════════

// GET /api/customer-chat/faq —— 获取 FAQ 文档列表（支持 category 过滤）
customerChatRoutes.get("/api/customer-chat/faq", async (c) => {
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

  // 如果有 category 过滤，根据 tag/标题匹配
  let filtered = docs;
  if (category) {
    filtered = docs.filter((d) => d.title.includes(category));
  }

  return c.json({ documents: filtered });
});

// GET /api/customer-chat/faq/categories —— 获取 FAQ 分类
customerChatRoutes.get("/api/customer-chat/faq/categories", async (c) => {
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

// ════════════════════════════════════════════════════════════════
// 客服数据概览（基础分析）
// ════════════════════════════════════════════════════════════════

// GET /api/customer-chat/analytics —— 客服统计概览
customerChatRoutes.get("/api/customer-chat/analytics", async (c) => {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 总客服会话数
    const totalConversations = await prisma.conversation.count({
      where: { type: "customer_service" },
    });

    // 今日会话数
    const todayConversations = await prisma.conversation.count({
      where: {
        type: "customer_service",
        createdAt: { gte: todayStart },
      },
    });

    // 总消息数
    const totalMessages = await prisma.message.count({
      where: {
        conversation: { type: "customer_service" },
      },
    });

    // 满意率（尝试从 satisfaction_ratings 表获取）
    let satisfactionRate = 0;
    let totalRatings = 0;
    try {
      const ratings = await prisma.$queryRawUnsafe<Array<{ count: bigint; rating: string }>>(
        `SELECT COUNT(*)::int as count, rating FROM satisfaction_ratings GROUP BY rating`,
      );
      if (Array.isArray(ratings)) {
        totalRatings = ratings.reduce((sum, r) => sum + Number(r.count), 0);
        const positive = ratings
          .filter((r) => r.rating === "positive" || r.rating?.startsWith("star_4") || r.rating?.startsWith("star_5"))
          .reduce((sum, r) => sum + Number(r.count), 0);
        satisfactionRate = totalRatings > 0 ? Math.round((positive / totalRatings) * 100) : 0;
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
