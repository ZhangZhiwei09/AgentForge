// Voice Service — WebSocket turn management for real-time voice interaction
// Pipeline: Browser PCM → ASR (Whisper) → LLM (ChatService) → TTS → Browser MP3
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { logger } from "@agentforge/logger";
import { getASRProvider, getTTSProvider } from "./audio-providers.js";
import { ChatService } from "./chat.js";
import { pcmToWav, estimateDuration } from "../lib/audio-utils.js";
import { settings } from "../config.js";

type TurnState = "listening" | "processing" | "speaking";

export class VoiceService {
  private conversationId: string;
  private userId: string;
  private voiceSessionId: string;

  private state: TurnState = "listening";
  private audioChunks: Buffer[] = [];
  private transcript: Array<{ role: string; content: string }> = [];
  private asrTokenTotal = 0;
  private ttsCharTotal = 0;
  private audioDurationSec = 0;

  private abortController: AbortController | null = null;

  // Callback to send messages back to the WebSocket client
  private sendFn: (msg: Record<string, unknown>) => void;

  constructor(
    conversationId: string,
    userId: string,
    sendFn: (msg: Record<string, unknown>) => void,
  ) {
    this.conversationId = conversationId;
    this.userId = userId;
    this.sendFn = sendFn;
    this.voiceSessionId = randomUUID();

    logger.info(
      { voiceSessionId: this.voiceSessionId, conversationId, userId },
      "Voice session started",
    );
  }

  // ---- Message Dispatch ----

  async handleMessage(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type as string;

    switch (type) {
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
      case "ping":
        // Keepalive — no action needed
        break;
      default:
        logger.warn({ type }, "Unknown voice message type");
    }
  }

  async close(): Promise<void> {
    // Abort any in-progress processing
    this.abortController?.abort();

    // Persist voice session
    try {
      await prisma.voiceSession.upsert({
        where: { id: this.voiceSessionId },
        create: {
          id: this.voiceSessionId,
          conversationId: this.conversationId,
          status: "ended",
          audioDurationSec: Math.round(this.audioDurationSec),
          asrTokenCount: this.asrTokenTotal,
          ttsCharCount: this.ttsCharTotal,
          transcript: this.transcript,
          voice: settings.ttsVoice,
        },
        update: {
          status: "ended",
          audioDurationSec: Math.round(this.audioDurationSec),
          asrTokenCount: this.asrTokenTotal,
          ttsCharCount: this.ttsCharTotal,
          transcript: this.transcript,
        },
      });
      logger.info(
        { voiceSessionId: this.voiceSessionId },
        "Voice session persisted",
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown";
      logger.error(
        { voiceSessionId: this.voiceSessionId, error: msg },
        "Failed to persist voice session",
      );
    }
  }

  getVoiceSessionId(): string {
    return this.voiceSessionId;
  }

  // ---- Turn Management ----

  private async onAudioChunk(chunk: Buffer): Promise<void> {
    // If AI is speaking, user is interrupting
    if (this.state === "speaking") {
      await this.onInterrupt();
    }
    this.state = "listening";
    this.audioChunks.push(chunk);

    // Track audio duration roughly
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

    await this.processAudioAndRespond();
  }

  private async onInterrupt(): Promise<void> {
    logger.info(
      { voiceSessionId: this.voiceSessionId },
      "Voice interrupted by user",
    );

    // Abort current LLM + TTS
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // Clear pending audio (user started speaking over AI)
    this.audioChunks = [];

    this.state = "listening";
    this.send({ type: "interrupted" });
    this.send({ type: "status", status: "listening" });
  }

  // ---- Core Pipeline: ASR → LLM → TTS ----

  private async processAudioAndRespond(): Promise<void> {
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
          voiceSessionId: this.voiceSessionId,
          textLen: asrResult.text.length,
          language: asrResult.language,
          asrLatencyMs: asrLatency,
          pcmBytes: pcmLength,
        },
        "ASR complete",
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

      // Step 2: LLM — reuse ChatService for memory injection + tool calling
      if (signal.aborted) return;

      const chatService = new ChatService();
      const assistantMsgId = randomUUID();
      let fullResponse = "";

      this.send({ type: "status", status: "processing" });

      for await (const chunk of chatService.streamChat(
        this.conversationId,
        userText,
        null, // modelId (use default)
        "", // systemPrompt (use built-in)
        null, // kbIds
        null, // enabledTools
        signal, // AbortSignal for cancellation
      )) {
        if (signal.aborted) break;

        if (chunk.type === "token" && chunk.content) {
          fullResponse += chunk.content;
          this.send({
            type: "response_text",
            text: chunk.content as string,
            message_id: assistantMsgId,
          });
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

      // Step 3: TTS — sentence-level streaming
      this.state = "speaking";
      this.send({ type: "status", status: "speaking" });

      const tts = getTTSProvider();

      // Split text into sentence groups (up to 3 sentences per chunk for efficiency)
      const sentences = fullResponse.match(/[^.!?]+[.!?]+[\s]*/g) || [
        fullResponse,
      ];
      const sentenceGroups: string[] = [];
      let currentGroup = "";

      for (const s of sentences) {
        currentGroup += s;
        if (currentGroup.length > 400 || sentenceGroups.length === 0) {
          sentenceGroups.push(currentGroup);
          currentGroup = "";
        }
      }
      if (currentGroup.trim()) {
        sentenceGroups.push(currentGroup);
      }

      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;

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
            { voiceSessionId: this.voiceSessionId, error: ttsMsg },
            "TTS sentence failed",
          );
          // Continue with next sentence instead of failing entirely
        }
      }

      if (signal.aborted) {
        this.send({ type: "interrupted" });
        this.state = "listening";
        return;
      }

      // Step 4: Done
      this.transcript.push({ role: "assistant", content: fullResponse });

      this.send({
        type: "done",
        message_id: assistantMsgId,
        usage: {
          asr_tokens: this.asrTokenTotal,
          tts_chars: this.ttsCharTotal,
          prompt_tokens: totalPromptTokens,
          completion_tokens: totalCompletionTokens,
        },
      });

      this.state = "listening";
      this.send({ type: "status", status: "idle" });

      logger.info(
        {
          voiceSessionId: this.voiceSessionId,
          responseLength: fullResponse.length,
          ttsChunks: sentenceGroups.length,
        },
        "Voice turn complete",
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error(
        { voiceSessionId: this.voiceSessionId, error: msg },
        "Voice pipeline error",
      );
      this.send({ type: "error", message: msg });
      this.state = "listening";
      this.send({ type: "status", status: "idle" });
    }
  }

  // ---- Helper ----

  private send(msg: Record<string, unknown>): void {
    try {
      this.sendFn(msg);
    } catch {
      // WebSocket may be closed
    }
  }
}
