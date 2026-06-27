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
  metadata: ParsedDocumentMetadata;
}

// ── V3.0: 多模态解析扩展类型 ─────────────────────────────

/** 资产引用：解析过程中提取的图片、音频片段等文件 */
export interface AssetRef {
  /** 唯一标识 */
  id: string;
  /** 原始文件路径或名称 */
  localPath: string;
  /** MinIO 存储 key（上传后获得） */
  minioKey?: string;
  /** 资产的公开 URL（签名 URL 或公开 URL） */
  publicUrl?: string;
  /** MIME 类型 */
  mimeType: string;
  /** 描述文本（alt text） */
  description?: string;
}

/** 解析后的分段 */
export interface ParsedSegment {
  /** 分段序号 */
  index: number;
  /** 分段内容（Markdown 格式） */
  content: string;
  /** 起始页码（PDF 等分页格式） */
  startPage?: number;
  /** 结束页码 */
  endPage?: number;
}

/** 解析后的元数据（扩展版） */
export interface ParsedDocumentMetadata {
  /** 字符数 */
  charCount: number;
  /** 页数（PDF） */
  pageCount?: number;
  /** 分段数 */
  segmentCount?: number;
  /** 资产数量 */
  assetCount?: number;
  /** 视频时长（秒），仅视频文件 */
  videoDurationSec?: number;
  /** 音频时长（秒），仅音频文件 */
  audioDurationSec?: number;
  /** OCR 置信度，仅图片文件 */
  ocrConfidence?: number;
  /** 解析器名称 */
  parserName: string;
}

/** V3.0: 多模态文档的统一 Markdown 输出 */
export interface ParsedMarkdownDocument {
  /** 主内容（Markdown 格式） */
  markdown: string;
  /** 提取的资产列表（图片、音频等） */
  assets: AssetRef[];
  /** 按页/段落分段（可选） */
  pages?: ParsedSegment[];
  /** 结构化的内容分段 */
  segments: ParsedSegment[];
  /** 扩展元数据 */
  metadata: ParsedDocumentMetadata;
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
