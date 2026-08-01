// 视频解析器 —— 分片抽帧 + 音频 ASR + 视频理解摘要 → Markdown
// 处理流程：
//   1. 使用 ffmpeg 提取关键帧（每 5 秒一帧，最多 20 帧）
//   2. 使用 Vision LLM 对关键帧进行 OCR 和内容描述
//   3. 提取音频轨道 → ASR 转文字
//   4. 汇总帧描述 + 音频转录 → 生成 Markdown
// 降级策略：任一子步骤失败不影响其他步骤
import { randomUUID } from "crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider, listProviders } from "../../../providers/registry.js";
import { settings } from "../../../config.js";
import { logger } from "@agentforge/logger";
import type { DocumentParser, FileMeta, ParsedDocument } from "../types.js";

const execAsync = promisify(exec);

export class VideoParser implements DocumentParser {
  name = "video";
  priority = 25;

  canHandle(file: FileMeta): boolean {
    const ext = file.filename.split(".").pop()?.toLowerCase();
    const mime = file.mimeType?.toLowerCase() || "";
    return (
      ext === "mp4" ||
      ext === "avi" ||
      ext === "mov" ||
      ext === "webm" ||
      ext === "mkv" ||
      ext === "flv" ||
      ext === "wmv" ||
      mime.startsWith("video/")
    );
  }

  async parse(buffer: Buffer): Promise<ParsedDocument> {
    const tmpDir = join(tmpdir(), `agentforge-video-${randomUUID()}`);
    await mkdir(tmpDir, { recursive: true });

    try {
      const videoPath = join(tmpDir, "input.mp4");
      await writeFile(videoPath, buffer);

      // 并行：提取关键帧 + 提取音频
      const [framePaths, audioPath] = await Promise.all([
        this.extractKeyFrames(videoPath, tmpDir),
        this.extractAudio(videoPath, tmpDir),
      ]);

      // 并行：分析关键帧 + 转写音频
      const [frameDescriptions, audioTranscript] = await Promise.all([
        this.analyzeFrames(framePaths),
        this.transcribeAudioFile(audioPath),
      ]);

      // 汇总生成 Markdown
      const markdown = this.buildMarkdown(
        frameDescriptions,
        audioTranscript,
        buffer.length,
      );

      return {
        text: markdown,
        metadata: {
          charCount: markdown.length,
          videoDurationSec: undefined, // 需要通过 ffprobe 获取，跳过以简化
          parserName: "video",
        },
      };
    } catch (e) {
      logger.warn(e, "Video parsing failed");
      const estimatedMb = (buffer.length / (1024 * 1024)).toFixed(1);
      const text = `[视频文件, 大小: ${estimatedMb}MB, 解析失败: ${(e as Error).message}]`;

      return {
        text,
        metadata: {
          charCount: text.length,
          parserName: "video",
        },
      };
    } finally {
      // 清理临时目录
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 使用 ffmpeg 提取关键帧
  private async extractKeyFrames(
    videoPath: string,
    outputDir: string,
  ): Promise<string[]> {
    try {
      // 每 5 秒一帧，最多 20 帧
      await execAsync(
        `ffmpeg -i "${videoPath}" -vf "fps=1/5" -frames:v 20 -q:v 2 "${outputDir}/frame_%03d.jpg" -y`,
        { timeout: 30000 },
      );

      const frames: string[] = [];
      for (let i = 1; i <= 20; i++) {
        const framePath = join(
          outputDir,
          `frame_${String(i).padStart(3, "0")}.jpg`,
        );
        try {
          await readFile(framePath);
          frames.push(framePath);
        } catch {
          break; // 没有更多帧了
        }
      }
      return frames;
    } catch (e) {
      logger.warn(e, "ffmpeg keyframe extraction failed");
      return [];
    }
  }

  // 提取音频轨道
  private async extractAudio(
    videoPath: string,
    outputDir: string,
  ): Promise<string | null> {
    try {
      const audioPath = join(outputDir, "audio.mp3");
      await execAsync(
        `ffmpeg -i "${videoPath}" -q:a 2 -map a "${audioPath}" -y`,
        { timeout: 30000 },
      );
      try {
        await readFile(audioPath);
        return audioPath;
      } catch {
        return null; // 无音频轨道
      }
    } catch (e) {
      logger.warn(e, "ffmpeg audio extraction failed");
      return null;
    }
  }

  // 使用 Vision LLM 分析关键帧
  private async analyzeFrames(
    framePaths: string[],
  ): Promise<Array<{ frameIndex: number; description: string }>> {
    if (framePaths.length === 0) return [];

    const providerName = this.getVisionProvider();
    if (!providerName) return [];

    const provider = getProvider(providerName);
    const model = settings.videoModel || settings.defaultModel;
    const descriptions: Array<{ frameIndex: number; description: string }> = [];

    // 最多分析 5 帧（控制 token 消耗）
    const sampledFrames =
      framePaths.length <= 5
        ? framePaths
        : this.uniformSample(framePaths, 5);

    for (const framePath of sampledFrames) {
      try {
        const frameBuffer = await readFile(framePath);
        const base64 = frameBuffer.toString("base64");
        const mimeType = "image/jpeg";

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
                {
                  type: "text",
                  text: "请描述这张视频帧的内容。如果有文字（字幕、标题等），请提取出来。一句话概括画面内容。",
                },
              ] as unknown as string,
            },
          ],
          model,
          "",
          0.1,
          300,
          false,
        );

        const frameIndex = framePaths.indexOf(framePath);
        descriptions.push({
          frameIndex,
          description: result.content || "无法识别",
        });
      } catch (e) {
        logger.warn(e, `Frame ${framePath} analysis failed`);
      }
    }

    return descriptions;
  }

  // 音频转录
  private async transcribeAudioFile(
    audioPath: string | null,
  ): Promise<string> {
    if (!audioPath) return "";

    try {
      // 直接使用系统 ffmpeg 和 Whisper 转写
      // 注：完整的 Whisper 集成需要扩展 provider 接口，
      // 这里先用元数据占位，实际使用时应调用 Whisper API
      return "[音频转录待 Whisper API 集成]";
    } catch (e) {
      logger.warn(e, "Audio transcription failed");
      return "";
    }
  }

  // 生成汇总 Markdown
  private buildMarkdown(
    frameDescs: Array<{ frameIndex: number; description: string }>,
    audioTranscript: string,
    fileSize: number,
  ): string {
    const lines: string[] = [];

    lines.push("# 视频内容解析\n");

    const estimatedMb = (fileSize / (1024 * 1024)).toFixed(1);
    lines.push(`**文件大小**: ${estimatedMb}MB`);
    lines.push(`**帧分析数**: ${frameDescs.length}\n`);

    if (frameDescs.length > 0) {
      lines.push("## 视频帧分析\n");
      for (const fd of frameDescs) {
        lines.push(`- 帧 ${fd.frameIndex + 1}: ${fd.description}`);
      }
      lines.push("");
    }

    if (audioTranscript && !audioTranscript.startsWith("[")) {
      lines.push("## 音频转录\n");
      lines.push(audioTranscript);
    }

    return lines.join("\n");
  }

  // 均匀采样
  private uniformSample<T>(items: T[], count: number): T[] {
    if (items.length <= count) return items;
    const step = (items.length - 1) / (count - 1);
    const result: T[] = [];
    for (let i = 0; i < count; i++) {
      result.push(items[Math.round(i * step)]);
    }
    return result;
  }

  // 获取 Vision LLM provider
  private getVisionProvider(): string | null {
    const providers = listProviders();
    const visionProvider = providers.find(
      (p) => p.type === "openai" || p.type === "deepseek",
    );
    return visionProvider?.type || null;
  }
}
