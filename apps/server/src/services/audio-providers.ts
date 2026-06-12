// Audio Providers — ASR (Whisper) and TTS with lazy registry pattern
// Follows the same pattern as services/embeddings.ts
import OpenAI from "openai";
import { settings } from "../config.js";
import { logger } from "@agentforge/logger";

// ---- Provider Interfaces ----

export interface ASRProvider {
  transcribe(audioBuffer: Buffer, options?: ASROptions): Promise<ASRResult>;
  readonly providerName: string;
}

export interface ASROptions {
  language?: string; // e.g. "zh", "en", "" for auto-detect
  prompt?: string; // optional context hint for transcription
}

export interface ASRResult {
  text: string;
  language: string;
  durationSec: number;
}

export interface TTSProvider {
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
  readonly providerName: string;
  listVoices(): VoiceProfile[];
}

export interface TTSOptions {
  voice?: string;
  speed?: number; // 0.25 - 4.0
  format?: "mp3" | "opus" | "aac" | "flac";
}

export interface TTSResult {
  audioBuffer: Buffer;
  format: string;
  durationSec: number;
}

export interface VoiceProfile {
  id: string;
  name: string;
  language: string;
  gender: "male" | "female" | "neutral";
}

// ---- OpenAI Whisper (ASR) ----

class OpenAIWhisperProvider implements ASRProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseUrl: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  get providerName(): string {
    return "openai-whisper";
  }

  async transcribe(
    audioBuffer: Buffer,
    options?: ASROptions,
  ): Promise<ASRResult> {
    const start = Date.now();
    // OpenAI SDK needs a File object; create one from the buffer
    const file = new File([new Uint8Array(audioBuffer)], "audio.wav", {
      type: "audio/wav",
    });

    try {
      const resp = await this.client.audio.transcriptions.create({
        file,
        model: settings.asrModel,
        language: options?.language || undefined,
        prompt: options?.prompt,
        response_format: "verbose_json",
      });

      const duration = Date.now() - start;
      logger.info(
        {
          provider: "openai-whisper",
          language: resp.language,
          textLength: resp.text.length,
          durationMs: duration,
        },
        "ASR transcription complete",
      );

      return {
        text: resp.text,
        language: resp.language || "unknown",
        durationSec: resp.duration || 0,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error({ error: msg }, "Whisper transcription failed");
      throw new Error(`Whisper transcription failed: ${msg}`);
    }
  }
}

// ---- OpenAI TTS ----

class OpenAITTSProvider implements TTSProvider {
  private client: OpenAI;

  constructor(apiKey: string, baseUrl: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
  }

  get providerName(): string {
    return "openai-tts";
  }

  listVoices(): VoiceProfile[] {
    return [
      { id: "alloy", name: "Alloy", language: "en", gender: "neutral" },
      { id: "echo", name: "Echo", language: "en", gender: "male" },
      { id: "fable", name: "Fable", language: "en", gender: "male" },
      { id: "nova", name: "Nova", language: "en", gender: "female" },
      { id: "onyx", name: "Onyx", language: "en", gender: "male" },
      { id: "shimmer", name: "Shimmer", language: "en", gender: "female" },
    ];
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    if (!text || text.trim().length === 0) {
      throw new Error("TTS text cannot be empty");
    }

    const start = Date.now();
    try {
      const resp = await this.client.audio.speech.create({
        model: settings.ttsModel,
        voice: (options?.voice || settings.ttsVoice) as
          | "alloy"
          | "echo"
          | "fable"
          | "nova"
          | "onyx"
          | "shimmer",
        input: text,
        speed: options?.speed ?? settings.ttsSpeed,
        response_format: options?.format || "mp3",
      });

      const audioBuffer = Buffer.from(await resp.arrayBuffer());
      const duration = Date.now() - start;

      logger.info(
        {
          provider: "openai-tts",
          voice: options?.voice || settings.ttsVoice,
          textLength: text.length,
          audioSize: audioBuffer.length,
          durationMs: duration,
        },
        "TTS synthesis complete",
      );

      return {
        audioBuffer,
        format: options?.format || "mp3",
        durationSec: 0, // Not provided by OpenAI TTS API
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.error({ error: msg }, "TTS synthesis failed");
      throw new Error(`TTS synthesis failed: ${msg}`);
    }
  }
}

// ---- Lazy Registry (same pattern as embeddings.ts) ----

const asrProviders: Record<string, ASRProvider> = {};
const ttsProviders: Record<string, TTSProvider> = {};
let initialized = false;

function initAudioProviders(): void {
  if (initialized) return;

  if (settings.openaiApiKey) {
    asrProviders["openai"] = new OpenAIWhisperProvider(
      settings.openaiApiKey,
      settings.openaiBaseUrl,
    );
    ttsProviders["openai"] = new OpenAITTSProvider(
      settings.openaiApiKey,
      settings.openaiBaseUrl,
    );
    logger.info("Audio providers initialized (OpenAI Whisper + TTS)");
  } else {
    logger.warn("No OpenAI API key configured — audio providers unavailable");
  }

  initialized = true;
}

export function getASRProvider(name?: string): ASRProvider {
  initAudioProviders();
  const n = name || "openai";
  if (!asrProviders[n]) {
    throw new Error(
      `ASR provider '${n}' is not configured. Set OPENAI_API_KEY in .env.`,
    );
  }
  return asrProviders[n];
}

export function getTTSProvider(name?: string): TTSProvider {
  initAudioProviders();
  const n = name || "openai";
  if (!ttsProviders[n]) {
    throw new Error(
      `TTS provider '${n}' is not configured. Set OPENAI_API_KEY in .env.`,
    );
  }
  return ttsProviders[n];
}

export function listVoices(): VoiceProfile[] {
  initAudioProviders();
  const tts = Object.values(ttsProviders)[0];
  return tts?.listVoices() ?? [];
}
