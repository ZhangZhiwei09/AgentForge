// Agent routes — POST /api/agent/run (SSE stream) and agent session management
import { streamSSE } from "hono/streaming";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { AgentService } from "../services/agent.js";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import { createHono } from "../lib/hono.js";
import { verifyConversationOwnership } from "../lib/conversation-guard.js";

export const agentRoutes = createHono();
const agentService = new AgentService();

// ---- Request Schemas ----

const agentRunSchema = z.object({
  conversation_id: z.string().min(1),
  task: z.string().min(1).max(16000, "Task must be at most 16000 characters"),
  model: z.string().nullable().optional(),
  max_iterations: z.number().int().min(1).max(20).default(10),
  tools: z.array(z.string()).nullable().optional(),
});

const agentRespondSchema = z.object({
  session_id: z.string().min(1),
  response: z.string().min(1).max(16000),
});

const agentApprovalSchema = z.object({
  session_id: z.string().min(1),
  approval_id: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  modified_args: z.record(z.unknown()).optional(),
  rejection_reason: z.string().max(500).optional(),
});

// ---- Routes ----

// POST /api/agent/run — Start an agent task with SSE streaming
agentRoutes.post(
  "/api/agent/run",
  zValidator("json", agentRunSchema),
  async (c) => {
    const { conversation_id, task, model, max_iterations, tools } =
      c.req.valid("json");
    const user = c.get("user");

    if (!(await verifyConversationOwnership(conversation_id, user.id))) {
      return c.json({ detail: "Conversation not found or access denied" }, 404);
    }

    logger.info(
      { conversationId: conversation_id, task: task.slice(0, 80), tools },
      "Agent task started",
    );

    // SSE streaming response
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of agentService.run(conversation_id, task, {
          model,
          maxIterations: max_iterations,
          tools,
        })) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        logger.error({ error: errMsg }, "Agent run failed");
        await stream.writeSSE({
          data: JSON.stringify({ type: "agent_error", error: errMsg, step: 0 }),
        });
      }
    });
  },
);

// POST /api/agent/respond — Resume a paused agent with user response
agentRoutes.post(
  "/api/agent/respond",
  zValidator("json", agentRespondSchema),
  async (c) => {
    const { session_id, response } = c.req.valid("json");
    const user = c.get("user");

    // Get session and verify it belongs to user's conversation
    const session = await agentService.getSession(session_id);
    if (!session) {
      return c.json({ detail: "Agent session not found" }, 404);
    }

    if (!(await verifyConversationOwnership(session.conversationId, user.id))) {
      return c.json({ detail: "Conversation not found or access denied" }, 404);
    }

    if (session.status !== "paused") {
      return c.json(
        { detail: `Agent session is ${session.status}, not paused` },
        400,
      );
    }

    logger.info({ sessionId: session_id }, "Agent session resumed");

    // Resume the paused agent session with the user's response
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of agentService.resume(session_id, response)) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        await stream.writeSSE({
          data: JSON.stringify({ type: "agent_error", error: errMsg, step: 0 }),
        });
      }
    });
  },
);

// POST /api/agent/approve — Approve or reject a pending tool execution (P1-5)
agentRoutes.post(
  "/api/agent/approve",
  zValidator("json", agentApprovalSchema),
  async (c) => {
    const { session_id, approval_id, action, modified_args, rejection_reason } =
      c.req.valid("json");
    const user = c.get("user");

    // Verify session exists and belongs to user's conversation
    const session = await agentService.getSession(session_id);
    if (!session) {
      return c.json({ detail: "Agent session not found" }, 404);
    }

    if (!(await verifyConversationOwnership(session.conversationId, user.id))) {
      return c.json({ detail: "Conversation not found or access denied" }, 404);
    }

    // Verify approval exists and belongs to this session
    let approval;
    try {
      approval = await prisma.agentApproval.findFirst({
        where: { id: approval_id, sessionId: session_id },
      });
    } catch {
      return c.json({ detail: "Approval not found" }, 404);
    }
    if (!approval) {
      return c.json({ detail: "Approval not found" }, 404);
    }
    if (approval.status !== "pending") {
      return c.json({ detail: `Approval is already ${approval.status}` }, 400);
    }

    if (session.status !== "paused") {
      return c.json(
        { detail: `Agent session is ${session.status}, not paused` },
        400,
      );
    }

    // Check timeout — server-side enforcement
    const elapsed = Date.now() - approval.requestedAt.getTime();
    if (elapsed > approval.timeoutMs) {
      try {
        await prisma.agentApproval.update({
          where: { id: approval_id },
          data: { status: "timed_out", decidedAt: new Date() },
        });
      } catch {
        /* ignore */
      }
      return c.json({ detail: "Approval request has timed out" }, 410);
    }

    logger.info(
      { sessionId: session_id, approvalId: approval_id, action },
      "Approval decision received",
    );

    // Stream the approval result + continued agent loop
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of agentService.handleApproval(
          session_id,
          approval_id,
          action,
          modified_args,
          rejection_reason,
        )) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        await stream.writeSSE({ data: "[DONE]" });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : "Unknown error";
        await stream.writeSSE({
          data: JSON.stringify({ type: "agent_error", error: errMsg, step: 0 }),
        });
      }
    });
  },
);

// GET /api/agent/approvals — List approval records for a session (P1-5)
agentRoutes.get("/api/agent/approvals", async (c) => {
  const sessionId = c.req.query("session_id");
  if (!sessionId) {
    return c.json({ detail: "Missing session_id parameter" }, 400);
  }

  const user = c.get("user");
  const session = await agentService.getSession(sessionId);
  if (!session) {
    return c.json({ detail: "Agent session not found" }, 404);
  }

  const conversation = await prisma.conversation.findFirst({
    where: { id: session.conversationId, userId: user.id },
  });
  if (!conversation) {
    return c.json({ detail: "Access denied" }, 403);
  }

  try {
    const records = await prisma.agentApproval.findMany({
      where: { sessionId },
      orderBy: { requestedAt: "desc" },
    });
    return c.json(records);
  } catch {
    return c.json([]);
  }
});

// GET /api/agent-sessions — List agent sessions for a conversation
agentRoutes.get("/api/agent-sessions", async (c) => {
  const conversationId = c.req.query("conversation_id");
  if (!conversationId) {
    return c.json({ detail: "Missing conversation_id parameter" }, 400);
  }

  const user = c.get("user");
  if (!(await verifyConversationOwnership(conversationId, user.id))) {
    return c.json({ detail: "Conversation not found or access denied" }, 404);
  }

  const sessions = await agentService.getSessions(conversationId);
  return c.json(sessions);
});

// GET /api/agent-sessions/:id — Get agent session detail with full scratchpad
agentRoutes.get("/api/agent-sessions/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const session = await agentService.getSession(id);
  if (!session) {
    return c.json({ detail: "Agent session not found" }, 404);
  }

  // Verify session belongs to user's conversation
  const conversation = await prisma.conversation.findFirst({
    where: { id: session.conversationId, userId: user.id },
  });
  if (!conversation) {
    return c.json({ detail: "Access denied" }, 403);
  }

  return c.json(session);
});
