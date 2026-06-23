// Document Parser Plugin System — types
//
// Parser 负责"读文件"，将二进制/文本格式统一提取为 ParsedDocument。
// 不做内容理解、不做结构恢复、不做质量判断。

/** Minimal file metadata used to select the correct parser. */
export interface FileMeta {
  filename: string;
  mimeType?: string;
}

/** Unified output of any document parser. */
export interface ParsedDocument {
  /** Extracted plain text content. */
  text: string;
  /** Per-page text (available for PDF; empty for flat-text formats). */
  pages?: Array<{ index: number; text: string }>;
  metadata: {
    /** Total number of pages (PDF) or undefined for flat formats. */
    pageCount?: number;
    /** Raw character count before any normalization. */
    charCount: number;
  };
}

/** A plugin that can parse a specific document format. */
export interface DocumentParser {
  /** Unique name for logging/debugging, e.g. "pdf", "text". */
  name: string;
  /** Higher priority wins when multiple parsers can handle the same file. */
  priority: number;
  /** Returns true if this parser can handle the given file. */
  canHandle(file: FileMeta): boolean;
  /** Parse the file buffer into a ParsedDocument. */
  parse(buffer: Buffer): Promise<ParsedDocument>;
}
