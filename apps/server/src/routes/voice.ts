// Voice routes — WebSocket bidirectional audio + HTTP one-shot endpoints
import { createHono } from "../lib/hono.js";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { authService } from "../services/auth.js";
import { VoiceService } from "../services/voice.js";
import {
  getASRProvider,
  getTTSProvider,
  listVoices,
} from "../services/audio-providers.js";
import { pcmToWav } from "../lib/audio-utils.js";
import { logger } from "@agentforge/logger";
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage } from "http";

export const voiceRoutes = createHono();

// ---- Validation Schemas ----

const synthesizeSchema = z.object({
  text: z.string().min(1).max(4096),
  voice: z.string().optional(),
  speed: z.number().min(0.25).max(4.0).optional(),
});

// ---- HTTP Endpoints ----

// POST /api/voice/transcribe — upload audio → text
voiceRoutes.post("/api/voice/transcribe", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return c.json({ detail: "No audio file provided" }, 400);
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const wavBuffer = pcmToWav(buffer);

    const asr = getASRProvider();
    const result = await asr.transcribe(wavBuffer);

    return c.json({
      text: result.text,
      language: result.language,
      duration_sec: result.durationSec,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ error: msg }, "Transcribe endpoint error");
    return c.json({ detail: msg }, 500);
  }
});

// POST /api/voice/synthesize — text → audio
voiceRoutes.post(
  "/api/voice/synthesize",
  zValidator("json", synthesizeSchema),
  async (c) => {
    const { text, voice, speed } = c.req.valid("json");

    try {
      const tts = getTTSProvider();
      const result = await tts.synthesize(text, { voice, speed });

      return c.body(new Uint8Array(result.audioBuffer), 200, {
        "Content-Type": `audio/${result.format}`,
        "Content-Length": String(result.audioBuffer.length),
        "X-Audio-Duration-Sec": String(result.durationSec),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error({ error: msg }, "Synthesize endpoint error");
      return c.json({ detail: msg }, 500);
    }
  },
);

// GET /api/voice/voices — list available voices
voiceRoutes.get("/api/voice/voices", (c) => {
  const voices = listVoices();
  return c.json({ voices });
});

// ---- WebSocket Endpoint: WS /api/voice/stream ----
// Manual WebSocket upgrade using `ws` package + Node.js raw req/res.
// Hono v4.12 changed the WS helper API; manual approach is more stable.

voiceRoutes.get("/api/voice/stream", async (c) => {
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

    const voiceService = new VoiceService(conversationId, user.id, sendFn);

    ws.on("message", (data: Buffer | string) => {
      try {
        const msg = JSON.parse(
          typeof data === "string" ? data : data.toString("utf-8"),
        );
        voiceService.handleMessage(msg);
      } catch {
        // Ignore malformed JSON
      }
    });

    ws.on("close", () => {
      voiceService.close().catch((err: unknown) => {
        logger.warn({ error: (err as Error)?.message }, "Voice close error");
      });
    });

    ws.on("error", (err: Error) => {
      logger.error({ error: err.message }, "Voice WebSocket error");
      voiceService.close().catch(() => {});
    });

    logger.info(
      { conversationId, voiceSessionId: voiceService.getVoiceSessionId() },
      "Voice WebSocket connected",
    );
  });

  // Perform the upgrade manually using the raw socket
  const socket = (
    req as IncomingMessage & {
      socket: { on: Function; removeListener?: Function };
    }
  ).socket;
  const head = Buffer.alloc(0);

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit("connection", ws, req);
  });

  // Return empty response — the socket has been upgraded
  return new Response(null, { status: 101 });
});
