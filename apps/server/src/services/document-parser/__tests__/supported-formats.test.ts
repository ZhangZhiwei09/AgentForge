import { describe, expect, it, vi } from "vitest";
import { getParserRegistry } from "../index.js";

vi.mock("../../../providers/registry.js", () => ({
  getProvider: vi.fn(),
  listProviders: vi.fn(() => []),
}));
vi.mock("../../../config.js", () => ({ settings: {} }));

describe("knowledge document formats", () => {
  it.each([
    ["manual.pdf", "application/pdf", "pdf"],
    ["manual.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word"],
    ["incident.txt", "text/plain", "text"],
    ["runbook.md", "text/markdown", "text"],
    ["screenshot.png", "image/png", "image"],
  ])("keeps the parser for %s", (filename, mimeType, expected) => {
    expect(getParserRegistry().getParser({ filename, mimeType })?.name).toBe(expected);
  });

  it.each([
    ["recording.mp3", "audio/mpeg"],
    ["recording.wav", "audio/wav"],
    ["recording.mp4", "video/mp4"],
    ["recording.webm", "video/webm"],
    ["archive.zip", "application/zip"],
  ])("rejects unsupported binary uploads: %s", (filename, mimeType) => {
    expect(getParserRegistry().getParser({ filename, mimeType })).toBeUndefined();
  });

  it("still extracts plain text without a model provider", async () => {
    const parser = getParserRegistry().getParser({ filename: "incident.log" });
    const result = await parser?.parse(Buffer.from("database connection timed out"));
    expect(result?.text).toBe("database connection timed out");
    expect(result?.metadata.parserName).toBe("text");
  });
});
