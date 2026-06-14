// Customer Video Session Service — anonymous customer video chat with knowledge base
// Pipeline: Camera + Mic → WebSocket → ASR + Vision → Multimodal LLM (with KB) → TTS
//
// Architecture:
//   Browser captures video frames (~3s interval JPEG) + audio (PCM chunks)
//   → WebSocket bidirectional transport (anonymous, no auth)
//   → Server buffers frames + audio
//   → On speech_end: ASR transcript + KB search + latest frames → Multimodal LLM (vision)
//   → TTS audio back to client
//
// Adapted from VideoSessionService (authenticated video) + CustomerChatService (anonymous KB chat)
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import { getASRProvider, getTTSProvider } from "./audio-providers.js";
import {
  getMultimodalProvider,
  buildVisionMessage,
} from "./multimodal-provider.js";
import { pcmToWav, estimateDuration } from "../lib/audio-utils.js";
import { settings } from "../config.js";

// Reuse the customer service prompt from the text chat service
const CUSTOMER_SERVICE_PROMPT = `你是一个专业的视频客服助手，通过视频通话为用户提供帮助。你可以看到用户的视频画面并听到用户的声音。

你的职责包括：
1. **咨询解答**：回答用户关于产品、服务、订单等方面的问题
2. **退单处理**：帮助用户处理和跟踪退货退款请求
3. **订单查询**：查询用户的订单状态和物流信息
4. **技术支持**：协助用户解决产品使用中的技术问题
5. **投诉处理**：认真倾听用户的不满，提供解决方案

沟通原则：
- 热情、专业、耐心地对待每一位用户
- 通过视频画面观察用户的情绪和状态，调整沟通方式
- 先理解问题再提供解决方案
- 对无法立即解决的问题，明确告知下一步流程和时间预期
- 保护用户隐私，不透露任何敏感信息
- 严格基于知识库内容回答问题，不确定时引导用户联系人工客服

{knowledge_context}`;

const CUSTOMER_USER_ID = "00000000-0000-0000-0000-000000000002";

type TurnState = "listening" | "processing" | "speaking";
type ConnectionState = "connecting" | "connected" | "disconnected";

interface CustomerVideoConfig {
  visionEnabled?: boolean;
  visionIntervalMs?: number;
}

export class CustomerVideoService {
  private sessionId: string | null;
  private conversationId: string | null = null;
  private videoSessionId: string;
  private config: CustomerVideoConfig;

  // State
  private state: TurnState = "listening";
  private connectionState: ConnectionState = "connecting";

  // Buffers
  private audioChunks: Buffer[] = [];
  private videoFrames: Array<{ data: string; timestamp: number }> = [];
  private transcript: Array<{ role: string; content: string }> = [];

  // Counters
  private asrTokenTotal = 0;
  private ttsCharTotal = 0;
  private audioDurationSec = 0;
  private videoDurationSec = 0;
  private framesSentToLLM = 0;

  // Control
  private abortController: AbortController | null = null;
  private sessionStartTime: number;

  // Callback to send messages back to the WebSocket client
  private sendFn: (msg: Record<string, unknown>) => void;

  constructor(
    sessionId: string | null,
    sendFn: (msg: Record<string, unknown>) => void,
    config: CustomerVideoConfig = {},
  ) {
    this.sessionId = sessionId;
    this.sendFn = sendFn;
    this.config = {
      visionEnabled: true,
      visionIntervalMs: 3000,
      ...config,
    };
    this.videoSessionId = randomUUID();
    this.sessionStartTime = Date.now();

    logger.info(
      {
        videoSessionId: this.videoSessionId,
        sessionId,
        config: this.config,
      },
      "Customer video session started",
    );
  }

  // ---- Conversation Management (matches CustomerChatService pattern) ----

  private async getOrCreateConversation(): Promise<string> {
    if (this.conversationId) return this.conversationId;

    if (this.sessionId) {
      const existing = await prisma.conversation.findFirst({
        where: { sessionId: this.sessionId, type: "customer_service" },
      });
      if (existing) {
        this.conversationId = existing.id;
        return existing.id;
      }
    }

    const conversation = await prisma.conversation.create({
      data: {
        id: randomUUID(),
        title: "视频客服会话",
        userId: CUSTOMER_USER_ID,
        type: "customer_service",
        sessionId: this.sessionId,
      },
    });
    this.conversationId = conversation.id;
    return conversation.id;
  }

  // ---- Knowledge Base Search (matches CustomerChatService pattern) ----

  private async fetchKnowledge(userMessage: string): Promise<{
    context: string;
    results: Array<{ content: string; score: number; docTitle: string }>;
  }> {
    try {
      const { KnowledgeService } = await import("./knowledge.js");
      const service = new KnowledgeService();
      const results = await service.search(userMessage, undefined, 3);

      if (!results.length) return { context: "", results: [] };

      const lines = [
        "【知识库参考资料 —— 以下每条数据均来自知识库，不可修改】",
      ];
      const scoredResults: Array<{
        content: string;
        score: number;
        docTitle: string;
      }> = [];
      results.forEach((r, i) => {
        const sourceTag = `[来源: ${r.docTitle || r.docId} | 不可修改 | 编号: KB-${i + 1}]`;
        lines.push(`${sourceTag}\n${r.content}`);
        scoredResults.push({
          content: r.content.slice(0, 300),
          score: r.score,
          docTitle: r.docTitle || r.docId,
        });
      });
      return {
        context: "\n\n" + lines.join("\n\n---\n\n"),
        results: scoredResults,
      };
    } catch (e) {
      logger.warn(e, "Customer video knowledge search failed");
      return { context: "", results: [] };
    }
  }

  // ---- Message Dispatch ----

  async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    switch (type) {
      case "start_video": {
        this.connectionState = "connected";
        this.send({
          type: "status",
          status: "connected",
          session_id: this.videoSessionId,
        });
        logger.info(
          { videoSessionId: this.videoSessionId },
          "Customer video connection established",
        );
        break;
      }

      case "video_frame": {
        const data = msg.data as string;
        const timestamp = msg.timestamp as number;
        if (data) {
          this.onVideoFrame(data, timestamp);
        }
        break;
      }

      case "audio": {
        const data = msg.data as string;
        if (data) {
          const chunk = Buffer.from(data, "base64");
          await this.onAudioChunk(chunk);
        }
        break;
      }

      case "speech_end":
        await this.onSpeechEnd();
        break;

      case "interrupt":
        await this.onInterrupt();
        break;

      case "stop_video":
        await this.onStopVideo();
        break;

      case "ping":
        // Keepalive
        break;

      default:
        logger.warn({ type }, "Unknown customer video message type");
    }
  }

  async close(): Promise<void> {
    this.abortController?.abort();

    const durationSec = Math.round((Date.now() - this.sessionStartTime) / 1000);

    try {
      await prisma.videoSession.upsert({
        where: { id: this.videoSessionId },
        create: {
          id: this.videoSessionId,
          conversationId: this.conversationId || "",
          status: "ended",
          videoDurationSec: this.videoDurationSec,
          audioDurationSec: Math.round(this.audioDurationSec),
          asrTokenCount: this.asrTokenTotal,
          ttsCharCount: this.ttsCharTotal,
          visionFramesCount: this.framesSentToLLM,
          transcript: this.transcript,
          agentConfig: this.config as any,
          endedAt: new Date(),
        },
        update: {
          status: "ended",
          videoDurationSec: this.videoDurationSec,
          audioDurationSec: Math.round(this.audioDurationSec),
          asrTokenCount: this.asrTokenTotal,
          ttsCharCount: this.ttsCharTotal,
          visionFramesCount: this.framesSentToLLM,
          transcript: this.transcript,
          endedAt: new Date(),
        },
      });
      logger.info(
        { videoSessionId: this.videoSessionId, durationSec },
        "Customer video session persisted",
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown";
      logger.error(
        { videoSessionId: this.videoSessionId, error: msg },
        "Failed to persist customer video session",
      );
    }
  }

  getVideoSessionId(): string {
    return this.videoSessionId;
  }

  // ---- Turn Management ----

  private onVideoFrame(data: string, timestamp: number): void {
    if (this.connectionState !== "connected") return;

    this.videoFrames.push({ data, timestamp });
    if (this.videoFrames.length > 5) {
      this.videoFrames = this.videoFrames.slice(-5);
    }

    this.videoDurationSec = Math.round(
      (Date.now() - this.sessionStartTime) / 1000,
    );
  }

  private async onAudioChunk(chunk: Buffer): Promise<void> {
    if (this.state === "speaking") {
      await this.onInterrupt();
    }
    this.state = "listening";
    this.audioChunks.push(chunk);
    this.audioDurationSec += estimateDuration(chunk.length);
  }

  private async onSpeechEnd(): Promise<void> {
    if (this.audioChunks.length === 0) {
      logger.debug("Speech end with no audio chunks — ignoring");
      return;
    }

    if (this.state === "processing") {
      logger.debug("Already processing — ignoring speech_end");
      return;
    }

    await this.processVideoAudioAndRespond();
  }

  private async onInterrupt(): Promise<void> {
    logger.info(
      { videoSessionId: this.videoSessionId },
      "Customer video session interrupted by user",
    );

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    this.audioChunks = [];
    this.state = "listening";
    this.send({ type: "interrupted" });
    this.send({ type: "status", status: "listening" });
  }

  private async onStopVideo(): Promise<void> {
    logger.info(
      { videoSessionId: this.videoSessionId },
      "Customer video session stopped by user",
    );
    this.connectionState = "disconnected";
    this.send({ type: "status", status: "idle" });
    await this.close();
  }

  // ---- Core Pipeline: Frames + Audio → ASR → KB → Vision LLM → TTS ----

  private async processVideoAudioAndRespond(): Promise<void> {
    this.state = "processing";
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    this.send({ type: "status", status: "processing" });

    try {
      // Step 1: ASR — PCM → WAV → Whisper
      const fullPcm = Buffer.concat(this.audioChunks);
      this.audioChunks = [];
      const pcmLength = fullPcm.length;

      const wavBuffer = pcmToWav(fullPcm, 16000, 1, 16);
      const asr = getASRProvider();
      const asrStart = Date.now();
      const asrResult = await asr.transcribe(wavBuffer);
      const asrLatency = Date.now() - asrStart;

      if (signal.aborted) return;

      this.asrTokenTotal += asrResult.text.length;
      logger.info(
        {
          videoSessionId: this.videoSessionId,
          textLen: asrResult.text.length,
          language: asrResult.language,
          asrLatencyMs: asrLatency,
          pcmBytes: pcmLength,
        },
        "Customer video ASR complete",
      );

      const userText = asrResult.text.trim();
      if (!userText) {
        this.state = "listening";
        this.send({ type: "status", status: "idle" });
        return;
      }

      // Send transcript to client
      this.transcript.push({ role: "user", content: userText });
      this.send({ type: "transcript", text: userText, is_final: true });

      if (signal.aborted) return;

      // Step 2: Knowledge Base Search (NEW — inherited from CustomerChatService)
      const { context: knowledgeContext } = await this.fetchKnowledge(userText);

      // Step 3: Build multimodal message with video frames
      const hasFrames =
        this.config.visionEnabled !== false && this.videoFrames.length > 0;

      if (hasFrames) {
        const frameCount = this.videoFrames.length;
        const latestTimestamp =
          this.videoFrames[this.videoFrames.length - 1].timestamp;
        this.send({
          type: "vision_context",
          description: `正在分析 ${frameCount} 个视频帧（最新: ${new Date(latestTimestamp).toISOString()}）`,
        });
      }

      // Step 4: Multimodal LLM call with KB context
      const multimodalLLM = getMultimodalProvider();

      // Build system prompt with knowledge context
      const systemPrompt = CUSTOMER_SERVICE_PROMPT.replace(
        "{knowledge_context}",
        knowledgeContext ||
          "\n\n（暂无知识库参考资料，请引导用户联系人工客服。）",
      );

      // Resolve conversation for history loading
      const convId = await this.getOrCreateConversation();

      // Load recent conversation history
      const history = await prisma.message.findMany({
        where: { conversationId: convId },
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      // Build messages array
      const messages: Array<{
        role: "user" | "assistant";
        content:
          | string
          | Array<
              | { type: "text"; text: string }
              | {
                  type: "image_url";
                  image_url: { url: string; detail?: string };
                }
            >;
      }> = [];

      // Add recent history (chronological order)
      for (const msg of history.reverse()) {
        messages.push({
          role: msg.role as "user" | "assistant",
          content: msg.content,
        });
      }

      // Add current user message with video frames
      if (hasFrames) {
        const visualPrompt = `[用户通过视频通话说]: ${userText}\n\n请根据视频画面中的用户状态和场景，提供合适的帮助。`;
        const visionMsg = buildVisionMessage(
          visualPrompt,
          this.videoFrames.map((f) => f.data),
          "low",
        );
        messages.push(visionMsg as any);
        this.framesSentToLLM += this.videoFrames.length;
      } else {
        messages.push({ role: "user", content: userText });
      }

      // Step 5: Stream multimodal LLM response
      if (signal.aborted) return;

      const assistantMsgId = randomUUID();
      let fullResponse = "";

      this.send({ type: "status", status: "speaking" });

      let promptTokens = 0;
      let completionTokens = 0;

      for await (const chunk of multimodalLLM.streamChat(
        messages as any,
        settings.defaultModel,
        systemPrompt,
        0.7,
        4096,
      )) {
        if (signal.aborted) break;

        if (chunk.type === "token" && chunk.content) {
          fullResponse += chunk.content;
          this.send({
            type: "response_text",
            text: chunk.content,
            message_id: assistantMsgId,
          });
        }

        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }

      if (signal.aborted) {
        this.send({ type: "interrupted" });
        this.state = "listening";
        return;
      }

      if (!fullResponse.trim()) {
        this.state = "listening";
        this.send({ type: "status", status: "idle" });
        return;
      }

      // Step 6: TTS — convert response to speech
      this.state = "speaking";

      const tts = getTTSProvider();

      const sentences = fullResponse.match(/[^.!?]+[.!?]+[\s]*/g) || [
        fullResponse,
      ];
      const sentenceGroups: string[] = [];
      let currentGroup = "";

      for (const s of sentences) {
        currentGroup += s;
        if (currentGroup.length > 400) {
          sentenceGroups.push(currentGroup);
          currentGroup = "";
        }
      }
      if (currentGroup.trim()) {
        sentenceGroups.push(currentGroup);
      }

      for (let i = 0; i < sentenceGroups.length; i++) {
        if (signal.aborted) break;

        try {
          const ttsResult = await tts.synthesize(sentenceGroups[i], {
            voice: settings.ttsVoice,
            speed: settings.ttsSpeed,
          });
          this.ttsCharTotal += sentenceGroups[i].length;

          this.send({
            type: "audio",
            data: ttsResult.audioBuffer.toString("base64"),
            sequence: i,
          });
        } catch (ttsErr: unknown) {
          const ttsMsg =
            ttsErr instanceof Error ? ttsErr.message : "Unknown error";
          logger.error(
            { videoSessionId: this.videoSessionId, error: ttsMsg },
            "TTS sentence failed",
          );
        }
      }

      if (signal.aborted) {
        this.send({ type: "interrupted" });
        this.state = "listening";
        return;
      }

      // Step 7: Save assistant message
      try {
        await prisma.message.create({
          data: {
            id: assistantMsgId,
            conversationId: convId,
            role: "assistant",
            content: fullResponse,
            model: settings.defaultModel,
          },
        });
      } catch (dbErr: unknown) {
        logger.error(
          { error: (dbErr as Error)?.message },
          "Failed to save customer video agent message",
        );
      }

      // Step 8: Done
      this.transcript.push({ role: "assistant", content: fullResponse });

      this.send({
        type: "done",
        message_id: assistantMsgId,
        usage: {
          asr_tokens: this.asrTokenTotal,
          tts_chars: this.ttsCharTotal,
          vision_frames: this.framesSentToLLM,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        },
      });

      this.state = "listening";
      this.send({ type: "status", status: "idle" });

      logger.info(
        {
          videoSessionId: this.videoSessionId,
          responseLength: fullResponse.length,
          ttsChunks: sentenceGroups.length,
          framesUsed: this.framesSentToLLM,
          kbAvailable: !!knowledgeContext,
        },
        "Customer video turn completed",
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error(
        { videoSessionId: this.videoSessionId, error: errorMsg },
        "Customer video processing error",
      );
      this.send({ type: "error", message: "处理语音时出现错误，请重试。" });
      this.state = "listening";
      this.send({ type: "status", status: "idle" });
    }
  }

  // ---- Helpers ----

  private send(msg: Record<string, unknown>): void {
    try {
      this.sendFn(msg);
    } catch {
      // Send failure — connection likely closed
    }
  }
}
