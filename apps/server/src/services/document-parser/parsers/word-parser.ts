// Word/DOCX 解析器 —— 将 .docx 文件转换为 Markdown
// 使用 mammoth 库进行转换，提取图片资产供 MinIO 上传
import mammoth from "mammoth";
import { randomUUID } from "crypto";
import type { DocumentParser, FileMeta, ParsedDocument, AssetRef } from "../types.js";
import { logger } from "@agentforge/logger";

export class WordParser implements DocumentParser {
  name = "word";
  priority = 40; // 高于 TextParser(10)，低于 PdfParser(50)

  canHandle(file: FileMeta): boolean {
    const ext = file.filename.split(".").pop()?.toLowerCase();
    const mime = file.mimeType?.toLowerCase() || "";
    return (
      ext === "docx" ||
      ext === "doc" ||
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mime === "application/msword"
    );
  }

  async parse(buffer: Buffer): Promise<ParsedDocument> {
    const assets: AssetRef[] = [];

    try {
      // 使用 mammoth 将 docx 转换为 Markdown，同时提取图片
      // mammoth v2 API: convertToMarkdown({ buffer }, options)
      const mammothAny = mammoth as unknown as {
        convertToMarkdown(
          input: { buffer: Buffer },
          options?: {
            convertImage?: {
              imgElement(
                handler: (image: {
                  read(): Promise<Buffer>;
                  contentType?: string;
                  altText?: string;
                }) => Promise<{ src: string }>,
              ): unknown;
            };
          },
        ): Promise<{ value: string; messages: Array<{ message: string }> }>;
        images: {
          imgElement(
            handler: (image: {
              read(): Promise<Buffer>;
              contentType?: string;
              altText?: string;
            }) => Promise<{ src: string }>,
          ): unknown;
        };
      };

      const result = await mammothAny.convertToMarkdown(
        { buffer },
        {
          convertImage: mammothAny.images.imgElement((image) => {
            return image.read().then((_imgBuffer) => {
              const assetId = randomUUID();
              const ext = image.contentType?.includes("png")
                ? "png"
                : image.contentType?.includes("jpeg")
                  ? "jpg"
                  : "bin";
              const localPath = `assets/${assetId}.${ext}`;

              assets.push({
                id: assetId,
                localPath,
                mimeType: image.contentType || "application/octet-stream",
                description: image.altText || undefined,
              });

              // 返回占位符，后续由 ingestion pipeline 替换为 MinIO URL
              return { src: `{{ASSET:${assetId}}}` };
            });
          }) as unknown as undefined,
        } as never,
      );

      const markdown = result.value;
      const warnings = result.messages;

      if (warnings.length > 0) {
        logger.info(
          { docxWarnings: warnings.map((w) => w.message) },
          "DOCX conversion warnings",
        );
      }

      // 按空行分段
      const paragraphs = markdown.split(/\n\n+/).filter((p) => p.trim());
      const segments = paragraphs.map((p, i) => ({
        index: i,
        content: p.trim(),
      }));

      return {
        text: markdown,
        pages: segments.map((s) => ({ index: s.index, text: s.content })),
        metadata: {
          charCount: markdown.length,
          pageCount: segments.length,
          parserName: "word",
        },
        // 扩展字段（ParsedDocument 接口不包含，但可在后续处理中使用）
      } as ParsedDocument & { _assets?: AssetRef[]; _segments?: typeof segments };
    } catch (e) {
      logger.error(e, "Word parser failed");
      throw new Error(`Word 文档解析失败: ${(e as Error).message}`);
    }
  }
}
