// 图片解析器 —— OCR 提取文字 + 生成 Markdown（含图片 URL）
// 使用多模态 Vision LLM（如 GPT-4o）进行 OCR 和图片描述
// 降级策略：Vision LLM 不可用时返回图片描述占位符
import { randomUUID } from "crypto";
import { getProvider, listProviders } from "../../../providers/registry.js";
import { settings } from "../../../config.js";
import { logger } from "@agentforge/logger";
import type { DocumentParser, FileMeta, ParsedDocument } from "../types.js";

export class ImageParser implements DocumentParser {
  name = "image";
  priority = 30;

  canHandle(file: FileMeta): boolean {
    const ext = file.filename.split(".").pop()?.toLowerCase();
    const mime = file.mimeType?.toLowerCase() || "";
    return (
      ext === "png" ||
      ext === "jpg" ||
      ext === "jpeg" ||
      ext === "gif" ||
      ext === "webp" ||
      ext === "bmp" ||
      ext === "tiff" ||
      mime.startsWith("image/")
    );
  }

  async parse(buffer: Buffer): Promise<ParsedDocument> {
    const base64 = buffer.toString("base64");
    const mimeType = this.detectMimeType(buffer);

    // OCR Prompt（中文）：让多模态模型提取图片中的文字
    const OCR_PROMPT = `请分析这张图片，完成以下任务：

1. 如果图片中包含文字，请完整提取所有文字内容。
2. 如果图片是图表、表格或截图，请描述其主要内容。
3. 如果图片是照片，请简要描述图片内容。

请以 Markdown 格式输出，包括：
- 提取的文字原文（如果有）
- 图片内容的简洁描述

请只输出内容，不要添加额外说明。`;

    try {
      // 通过 provider 抽象层调用多模态模型
      const providerName = this.getVisionProvider();
      if (!providerName) {
        return this.fallbackResult(buffer, mimeType);
      }

      const provider = getProvider(providerName);
      const model = settings.videoModel || settings.defaultModel;

      // 构造多模态消息
      const result = await provider.chatSync(
        [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType};base64,${base64}`,
                },
              },
              { type: "text", text: OCR_PROMPT },
            ] as unknown as string, // Provider 抽象层处理
          },
        ],
        model,
        "",
        0.1,
        2000,
        false,
      );

      const markdown = result.content || "";

      return {
        text: markdown,
        metadata: {
          charCount: markdown.length,
          ocrConfidence: 0.8,
          parserName: "image",
        },
      };
    } catch (e) {
      logger.warn(e, "Image OCR via Vision LLM failed");
      return this.fallbackResult(buffer, mimeType);
    }
  }

  // 降级：仅图片描述占位符
  private fallbackResult(buffer: Buffer, mimeType: string): ParsedDocument {
    const estimatedKb = Math.round(buffer.length / 1024);
    const text = `[图片文件: ${mimeType}, 大小: ${estimatedKb}KB, 未提取文字内容]`;

    return {
      text,
      metadata: {
        charCount: text.length,
        parserName: "image",
      },
    };
  }

  // 检测图片 MIME 类型
  private detectMimeType(buffer: Buffer): string {
    const header = buffer.slice(0, 4);
    if (header[0] === 0xff && header[1] === 0xd8) return "image/jpeg";
    if (
      header[0] === 0x89 &&
      header[1] === 0x50 &&
      header[2] === 0x4e &&
      header[3] === 0x47
    )
      return "image/png";
    if (header[0] === 0x47 && header[1] === 0x49) return "image/gif";
    if (header[0] === 0x52 && header[1] === 0x49) return "image/webp";
    return "image/png"; // 默认
  }

  // 获取可用的 Vision LLM provider
  private getVisionProvider(): string | null {
    const providers = listProviders();
    // 优先选择 openai（支持多模态）
    const visionProviders = providers.filter(
      (p) => p.type === "openai" || p.type === "deepseek",
    );
    return visionProviders[0]?.type || null;
  }
}
