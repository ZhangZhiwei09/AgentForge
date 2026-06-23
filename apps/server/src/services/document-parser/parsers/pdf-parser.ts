// PdfParser — extracts text from PDF files via unpdf (pdfjs-dist wrapper).
// Priority 50: takes precedence over generic TextParser for .pdf files.

import type { DocumentParser, FileMeta, ParsedDocument } from "../types.js";
import { logger } from "@agentforge/logger";

export class PdfParser implements DocumentParser {
  name = "pdf";
  priority = 50;

  canHandle(file: FileMeta): boolean {
    const ext = file.filename.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "pdf") return true;
    if (file.mimeType === "application/pdf") return true;
    return false;
  }

  async parse(buffer: Buffer): Promise<ParsedDocument> {
    // Dynamic import — unpdf is ESM-only and has heavy deps (pdfjs-dist)
    const { extractText } = await import("unpdf");

    let text: string;
    let totalPages: number;
    try {
      // unpdf v1.6: extractText(buffer) returns { totalPages, text: string[] }
      // With mergePages:true returns { totalPages, text: string }
      const raw = await extractText(buffer, { mergePages: true });
      text = raw.text;
      totalPages = raw.totalPages;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn({ error: msg }, "PDF extraction failed");

      // Classify the failure type so the caller can surface a clear message
      if (
        msg.toLowerCase().includes("password") ||
        msg.toLowerCase().includes("encrypted")
      ) {
        throw new Error(
          "PDF 已加密，请上传未设置密码保护的版本",
          { cause: e },
        );
      }
      if (
        msg.toLowerCase().includes("invalid") ||
        msg.toLowerCase().includes("corrupt") ||
        msg.toLowerCase().includes("not a pdf")
      ) {
        throw new Error("PDF 文件已损坏或格式无效", { cause: e });
      }
      throw new Error(`PDF 解析失败: ${msg}`, { cause: e });
    }

    return {
      text,
      metadata: {
        pageCount: totalPages,
        charCount: text.length,
      },
    };
  }
}
