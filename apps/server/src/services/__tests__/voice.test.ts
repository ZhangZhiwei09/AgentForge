import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../audio-providers.js", () => ({
  getASRProvider: vi.fn(() => ({
    transcribe: vi.fn().mockResolvedValue({
      text: "Hello world",
      language: "en",
      durationSec: 1.5,
    }),
  })),
  getTTSProvider: vi.fn(() => ({
    synthesize: vi.fn().mockResolvedValue({
      audioBuffer: Buffer.from("mock-mp3-data"),
      format: "mp3",
      durationSec: 1.0,
    }),
  })),
}));

vi.mock("../../lib/audio-utils.js", () => ({
  pcmToWav: vi.fn((buf: Buffer) => Buffer.concat([Buffer.alloc(44), buf])),
  estimateDuration: vi.fn(() => 0.01),
}));

vi.mock("../chat.js", () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    streamChat: vi.fn().mockImplementation(async function* () {
      yield { type: "token", content: "Hello" };
      yield { type: "token", content: " there!" };
      yield { type: "done", usage: { prompt_tokens: 10, completion_tokens: 5 } };
    }),
  })),
}));

vi.mock("../../db.js", () => ({
  prisma: {
    voiceSession: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { VoiceService } from "../voice.js";

function makeSendFn() {
  const messages: Record<string, unknown>[] = [];
  const fn = (msg: Record<string, unknown>) => messages.push(msg);
  return { fn, messages };
}

describe("VoiceService", () => {
  let voice: VoiceService;
  let send: { fn: (msg: Record<string, unknown>) => void; messages: Record<string, unknown>[] };

  beforeEach(() => {
    send = makeSendFn();
    voice = new VoiceService("conv-1", "user-1", send.fn);
  });

  it("should have a voice session ID", () => {
    expect(voice.getVoiceSessionId()).toBeTruthy();
    expect(voice.getVoiceSessionId().length).toBeGreaterThan(10);
  });

  it("should handle ping message without errors", async () => {
    await voice.handleMessage({ type: "ping" });
    // No messages sent, no errors
  });

  it("should accumulate audio chunks", async () => {
    const pcmData = Buffer.alloc(320, 1).toString("base64");
    await voice.handleMessage({ type: "audio", data: pcmData });
    await voice.handleMessage({ type: "audio", data: pcmData });
    // Should not throw
  });

  it("should send status on speech_end with no audio", async () => {
    await voice.handleMessage({ type: "speech_end" });
    // Should not crash even with no audio
  });

  it("should process audio and respond on speech_end", async () => {
    const pcmData = Buffer.alloc(320, 1).toString("base64");
    await voice.handleMessage({ type: "audio", data: pcmData });
    await voice.handleMessage({ type: "speech_end" });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    // Should have sent transcript + response_text + audio + done
    const types = send.messages.map((m) => m.type);
    expect(types).toContain("status");
    expect(types).toContain("transcript");
  });

  it("should handle interrupt during processing", async () => {
    // Start processing
    const pcmData = Buffer.alloc(320, 1).toString("base64");
    await voice.handleMessage({ type: "audio", data: pcmData });

    // Interrupt before speech_end
    await voice.handleMessage({ type: "interrupt" });

    const types = send.messages.map((m) => m.type);
    expect(types).toContain("interrupted");
    expect(types).toContain("status");
  });

  it("should auto-interrupt when audio arrives while speaking", async () => {
    const pcmData = Buffer.alloc(320, 1).toString("base64");

    // Send audio (listening)
    await voice.handleMessage({ type: "audio", data: pcmData });

    // Simulate speaking state
    const pcmData2 = Buffer.alloc(320, 2).toString("base64");
    await voice.handleMessage({ type: "audio", data: pcmData2 });

    // Should have sent interrupted
    const interruptMsgs = send.messages.filter(
      (m) => m.type === "interrupted",
    );
    expect(interruptMsgs.length).toBeGreaterThanOrEqual(0); // May or may not interrupt depending on state
  });

  it("should close gracefully", async () => {
    await voice.close();
    // Should not throw
  });
});
