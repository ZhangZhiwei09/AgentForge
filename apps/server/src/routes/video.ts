// Video routes — WebSocket bidirectional video + audio + HTTP endpoints
// Pipeline: Browser Camera + Mic → WebSocket → ASR + Vision → Multimodal LLM → TTS → Browser
import { createHono } from "../lib/hono.js";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { authService } from "../services/auth.js";
import { VideoSessionService } from "../services/video.js";
import { listMultimodalModels } from "../services/multimodal-provider.js";
import { logger } from "@agentforge/logger";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "http";

export const videoRoutes = createHono();

// ---- Validation Schemas ----

const createSessionSchema = z.object({
  conversation_id: z.string().min(1),
  agent_config: z
    .object({
      system_prompt: z.string().max(4096).optional(),
      enabled_tools: z.array(z.string()).optional(),
      vision_enabled: z.boolean().optional(),
      vision_interval_ms: z.number().min(500).max(10000).optional(),
    })
    .optional(),
});

// ---- HTTP Endpoints ----

// GET /api/video/models — list vision-capable models
videoRoutes.get("/api/video/models", (c) => {
  const models = listMultimodalModels();
  return c.json({ models });
});

// POST /api/video/sessions — create a video session (returns session info)
videoRoutes.post(
  "/api/video/sessions",
  zValidator("json", createSessionSchema),
  async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json({ detail: "Authentication required" }, 401);
    }

    const { conversation_id, agent_config } = c.req.valid("json");

    // Validate conversation belongs to user
    const { prisma } = await import("../db.js");
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversation_id },
    });

    if (!conversation) {
      return c.json({ detail: "Conversation not found" }, 404);
    }
    if (conversation.userId !== user.id) {
      return c.json({ detail: "Access denied" }, 403);
    }

    return c.json({
      conversation_id,
      agent_config: agent_config || {},
      ws_endpoint: `/api/video/stream?token=<your_token>&conversation_id=${conversation_id}`,
    });
  },
);

// ---- WebSocket Endpoint: WS /api/video/stream ----
// Manual WebSocket upgrade using `ws` package + Node.js raw req/res.
// Same pattern as voice.ts — reliable across Hono versions.

videoRoutes.get("/api/video/stream", async (c) => {
  // Auth via query param (browser WebSocket API doesn't support custom headers)
  const token = c.req.query("token");
  const conversationId = c.req.query("conversation_id");

  if (!token) {
    return c.json({ detail: "Authentication required" }, 401);
  }

  if (!conversationId) {
    return c.json({ detail: "conversation_id is required" }, 400);
  }

  const user = await authService.validateToken(token);
  if (!user) {
    return c.json({ detail: "Invalid or expired token" }, 401);
  }

  // Parse optional agent config from query params
  const visionEnabled = c.req.query("vision_enabled") !== "false";
  const visionIntervalMs = parseInt(
    c.req.query("vision_interval_ms") || "3000",
    10,
  );

  // Access raw Node.js request/response from @hono/node-server env
  const env = c.env as Record<string, unknown> | undefined;
  const req = env?.incoming as IncomingMessage | undefined;

  if (!req) {
    return c.json({ detail: "WebSocket not supported in this runtime" }, 400);
  }

  // Check for WebSocket upgrade headers
  const upgrade = c.req.header("upgrade");
  if (upgrade?.toLowerCase() !== "websocket") {
    return c.json({ detail: "WebSocket upgrade required" }, 426);
  }

  // Create a per-request WebSocket server (noServer mode)
  const wss = new WebSocketServer({ noServer: true });

  // Listen for the connection event
  wss.on("connection", (ws: WebSocket) => {
    const sendFn = (msg: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    const videoService = new VideoSessionService(
      conversationId,
      user.id,
      sendFn,
      {
        visionEnabled,
        visionIntervalMs,
      },
    );

    // Send initial session info
    sendFn({
      type: "session",
      session_id: videoService.getVideoSessionId(),
      config: {
        vision_enabled: visionEnabled,
        vision_interval_ms: visionIntervalMs,
      },
    });

    ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(
          typeof data === "string" ? data : data.toString("utf-8"),
        );
        videoService.handleMessage(msg).catch((err: unknown) => {
          logger.error(
            { error: (err as Error)?.message },
            "Video message handler error",
          );
        });
      } catch {
        // Ignore malformed JSON
      }
    });

    ws.on("close", () => {
      videoService.close().catch((err: unknown) => {
        logger.warn({ error: (err as Error)?.message }, "Video close error");
      });
    });

    ws.on("error", (err: Error) => {
      logger.error({ error: err.message }, "Video WebSocket error");
      videoService.close().catch(() => {});
    });

    logger.info(
      {
        conversationId,
        videoSessionId: videoService.getVideoSessionId(),
      },
      "Video WebSocket connected",
    );
  });

  // Perform the upgrade manually using the raw socket.
  // CRITICAL: Prevent Hono's adapter from double-writing (see customer-video.ts).
  const socket = (
    req as IncomingMessage & {
      socket: { on: Function; removeListener?: Function };
    }
  ).socket;
  const head = Buffer.alloc(0);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = env?.res as any;

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit("connection", ws, req);
  });

  if (res) {
    res.writeHead = () => res;
    res.write = () => true;
    res.end = () => res;
    res.setHeader = () => res;
  }

  return new Response(null, { status: 101 });
});
