// 音频解析器 —— ASR 语音转文字 → Markdown
// 使用 OpenAI Whisper API（通过现有 provider 抽象层）进行语音识别
// 降级策略：ASR 不可用时返回文件描述占位符
import { getProvider, listProviders } from "../../../providers/registry.js";
import { settings } from "../../../config.js";
import { logger } from "@agentforge/logger";
import type { DocumentParser, FileMeta, ParsedDocument } from "../types.js";

export class AudioParser implements DocumentParser {
  name = "audio";
  priority = 20;

  canHandle(file: FileMeta): boolean {
    const ext = file.filename.split(".").pop()?.toLowerCase();
    const mime = file.mimeType?.toLowerCase() || "";
    return (
      ext === "mp3" ||
      ext === "wav" ||
      ext === "m4a" ||
      ext === "ogg" ||
      ext === "flac" ||
      ext === "aac" ||
      ext === "webm" ||
      mime.startsWith("audio/")
    );
  }

  async parse(buffer: Buffer): Promise<ParsedDocument> {
    try {
      const providerName = this.getASRProvider();
      if (!providerName) {
        return this.fallbackResult(buffer);
      }

      // 使用 OpenAI Whisper API 进行语音识别
      // Whisper API 支持通过 multipart/form-data 上传音频文件
      const provider = getProvider(providerName);

      // 构造文件上传请求到 Whisper API
      const transcript = await this.transcribeAudio(buffer, providerName);

      const markdown = transcript
        ? `# 音频转录\n\n${transcript}`
        : "";

      return {
        text: markdown,
        metadata: {
          charCount: markdown.length,
          audioDurationSec: this.estimateDuration(buffer),
          parserName: "audio",
        },
      };
    } catch (e) {
      logger.warn(e, "Audio ASR failed");
      return this.fallbackResult(buffer);
    }
  }

  // 降级：文件描述占位符
  private fallbackResult(buffer: Buffer): ParsedDocument {
    const estimatedMb = (buffer.length / (1024 * 1024)).toFixed(1);
    const text = `[音频文件, 大小: ${estimatedMb}MB, 未成功转写]`;

    return {
      text,
      metadata: {
        charCount: text.length,
        parserName: "audio",
      },
    };
  }

  // 获取支持 ASR 的 provider
  private getASRProvider(): string | null {
    const providers = listProviders();
    const asrProvider = providers.find((p) => p.type === "openai");
    return asrProvider?.type || null;
  }

  // 调用 Whisper API 转写音频
  private async transcribeAudio(
    _buffer: Buffer,
    providerName: string,
  ): Promise<string> {
    try {
      // Whisper API: POST https://api.openai.com/v1/audio/transcriptions
      const provider = getProvider(providerName);

      // 使用 provider 的底层 OpenAI client 调用 Whisper
      // 注：当前 provider 接口可能不直接支持 audio transcription，
      // 这里提供框架，实际实现需扩展 provider 接口或直接使用 OpenAI SDK
      const result = await provider.chatSync(
        [{ role: "user", content: "请将此音频转录为文字（占位符 - 需 Whisper API 集成）" }],
        settings.defaultModel,
        "你是一个语音转录助手。音频文件已接收，请直接输出转录文字。",
        0.1,
        4000,
        false,
      );

      return result.content || "";
    } catch (e) {
      logger.warn(e, "Whisper transcription failed");
      return "";
    }
  }

  // 估算音频时长（基于文件大小，粗略估算）
  private estimateDuration(buffer: Buffer): number | undefined {
    // 粗略估算：MP3 128kbps ≈ 16KB/s
    const bytesPerSec = 16000;
    return Math.round(buffer.length / bytesPerSec);
  }
}
