import { describe, it, expect } from "vitest";
import { pcmToWav, estimateDuration } from "../audio-utils.js";

describe("pcmToWav", () => {
  it("should create valid WAV with RIFF header", () => {
    const pcm = Buffer.alloc(320, 0); // 320 bytes = 10ms of 16kHz 16-bit mono
    const wav = pcmToWav(pcm, 16000, 1, 16);

    // Check RIFF header
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");

    // Check fmt subchunk
    expect(wav.subarray(12, 16).toString()).toBe("fmt ");

    // Check data subchunk
    expect(wav.subarray(36, 40).toString()).toBe("data");
  });

  it("should calculate correct file size", () => {
    const pcm = Buffer.alloc(320, 0);
    const wav = pcmToWav(pcm, 16000, 1, 16);

    // File size stored at offset 4 (32-bit LE)
    const fileSize = wav.readUInt32LE(4);
    expect(fileSize).toBe(wav.length - 8);
    expect(wav.length).toBe(44 + 320); // header + data
  });

  it("should set correct sample rate", () => {
    const pcm = Buffer.alloc(100, 0);
    const wav = pcmToWav(pcm, 24000, 2, 16);

    const sampleRate = wav.readUInt32LE(24);
    expect(sampleRate).toBe(24000);

    const channels = wav.readUInt16LE(22);
    expect(channels).toBe(2);

    const bitsPerSample = wav.readUInt16LE(34);
    expect(bitsPerSample).toBe(16);
  });

  it("should handle empty buffer", () => {
    const pcm = Buffer.alloc(0);
    const wav = pcmToWav(pcm);

    // Should still produce valid WAV with 0 data bytes
    expect(wav.length).toBe(44);
    const dataSize = wav.readUInt32LE(40);
    expect(dataSize).toBe(0);
  });

  it("should produce byte-aligned format chunk", () => {
    const pcm = Buffer.alloc(160, 0);
    const wav = pcmToWav(pcm, 16000, 1, 16);

    const byteRate = wav.readUInt32LE(28);
    // 16000 Hz * 1 channel * 16 bits / 8 = 32000 bytes/sec
    expect(byteRate).toBe(32000);

    const blockAlign = wav.readUInt16LE(32);
    expect(blockAlign).toBe(2); // 1 channel * 2 bytes/sample
  });
});

describe("estimateDuration", () => {
  it("should estimate duration for PCM 16kHz 16-bit mono", () => {
    // 32000 bytes = 1 second at 16kHz 16-bit mono
    const duration = estimateDuration(32000, 16000, 1, 16);
    expect(duration).toBeCloseTo(1.0, 1);
  });

  it("should estimate duration for stereo audio", () => {
    // 64000 bytes = 1 second at 16kHz 16-bit stereo
    const duration = estimateDuration(64000, 16000, 2, 16);
    expect(duration).toBeCloseTo(1.0, 1);
  });

  it("should return 0 for empty buffer", () => {
    const duration = estimateDuration(0);
    expect(duration).toBe(0);
  });
});
