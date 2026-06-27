// TextParser — handles plain-text formats.
// Priority 10: low baseline, so format-specific parsers (PDF) take precedence.

import type { DocumentParser, FileMeta, ParsedDocument } from "../types.js";

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "json", "csv", "html", "xml", "yaml", "yml", "log",
]);

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/x-yaml",
];

export class TextParser implements DocumentParser {
  name = "text";
  priority = 10;

  canHandle(file: FileMeta): boolean {
    const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";
    if (TEXT_EXTENSIONS.has(ext)) return true;
    if (file.mimeType) {
      return TEXT_MIME_PREFIXES.some((prefix) =>
        file.mimeType!.startsWith(prefix),
      );
    }
    return false;
  }

  async parse(buffer: Buffer): Promise<ParsedDocument> {
    const text = buffer.toString("utf-8");
    return {
      text,
      metadata: { charCount: text.length, parserName: "text" },
    };
  }
}
