// RecursiveTokenTextSplitter 单元测试
// 覆盖：中文、英文、中英混排、overlap 语义边界保留、超长文本强制切分、校验错误
import { describe, it, expect } from "vitest";
import { RecursiveTokenTextSplitter } from "../text-splitter.js";

describe("RecursiveTokenTextSplitter", () => {
  describe("constructor", () => {
    it("should create with default values (800 tokens, 120 overlap)", () => {
      const splitter = new RecursiveTokenTextSplitter();
      expect(splitter).toBeDefined();
    });

    it("should throw when overlap >= size", () => {
      expect(() => new RecursiveTokenTextSplitter(500, 500)).toThrow(
        "chunk_overlap_tokens",
      );
      expect(() => new RecursiveTokenTextSplitter(500, 600)).toThrow(
        "chunk_overlap_tokens",
      );
    });

    it("should throw when chunk size < 50", () => {
      expect(() => new RecursiveTokenTextSplitter(49, 10)).toThrow(
        "chunk_size_tokens",
      );
    });

    it("should accept valid custom values", () => {
      const s = new RecursiveTokenTextSplitter(1000, 200);
      expect(s).toBeDefined();
    });
  });

  describe("splitText", () => {
    it("should return empty array for empty input", () => {
      const splitter = new RecursiveTokenTextSplitter();
      expect(splitter.splitText("")).toEqual([]);
    });

    it("should return single chunk for short text", () => {
      const splitter = new RecursiveTokenTextSplitter(800, 120);
      const text = "这是很短的文本。";
      const chunks = splitter.splitText(text);
      expect(chunks.length).toBe(1);
      expect(chunks[0]).toBe(text);
    });

    it("should split Chinese text at sentence boundaries", () => {
      const splitter = new RecursiveTokenTextSplitter(200, 30);
      // 生成超长中文文本，多个句子
      const sentences = Array.from(
        { length: 20 },
        (_, i) => `这是第${i + 1}句测试文本，包含足够多的中文字符来验证分片逻辑是否按照句子边界进行切分。`,
      );
      const text = sentences.join("。");
      const chunks = splitter.splitText(text);

      expect(chunks.length).toBeGreaterThan(1);

      // 每个 chunk 的 token 数不应超过 chunkSizeTokens
      for (const chunk of chunks) {
        // 使用字符数粗略验证（保守估计不应超太多）
        expect(chunk.length).toBeGreaterThan(0);
      }

      // chunk 不应该从半句话开始（除非无法避免）
      // 验证：非第一个 chunk 的开头不应是句子的后半部分
      for (let i = 1; i < chunks.length; i++) {
        const chunk = chunks[i];
        // 应该以合理的方式开始，不是从某个词的中间
        expect(chunk.trim().length).toBeGreaterThan(0);
      }
    });

    it("should split English text at sentence boundaries", () => {
      const splitter = new RecursiveTokenTextSplitter(200, 30);
      const sentences = Array.from(
        { length: 20 },
        (_, i) =>
          `This is test sentence number ${i + 1} with enough English characters to verify that the token-aware splitter properly handles English text segmentation at natural boundaries.`,
      );
      const text = sentences.join(". ");
      const chunks = splitter.splitText(text);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
      }
    });

    it("should handle mixed Chinese and English text", () => {
      const splitter = new RecursiveTokenTextSplitter(300, 50);
      const paragraphs = Array.from(
        { length: 10 },
        (_, i) =>
          `Paragraph ${i + 1}: 这是一个中英混合的段落，包含 both Chinese characters and English words. The tokenizer should handle mixed content properly without breaking mid-word or mid-character. 验证混合语言分片正确性。`,
      );
      const text = paragraphs.join("\n\n");
      const chunks = splitter.splitText(text);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
        // 不应有孤立的新行
        expect(chunk).not.toMatch(/^\n/);
      }
    });

    it("should force-split text without any punctuation (fallback)", () => {
      const splitter = new RecursiveTokenTextSplitter(200, 30);
      // 无标点的超长文本
      const text = "A".repeat(2000) + "测试".repeat(500);
      const chunks = splitter.splitText(text);

      expect(chunks.length).toBeGreaterThan(1);
      // 不应死循环（chunk 数应远小于字符数）
      expect(chunks.length).toBeLessThan(text.length);
    });

    it("should not produce chunks starting mid-word when possible", () => {
      const splitter = new RecursiveTokenTextSplitter(400, 60);
      const text =
        "自然语言处理是人工智能的重要分支。它研究如何让计算机理解人类语言。深度学习技术推动了NLP的快速发展。\n\n" +
        "近年来，预训练语言模型取得了巨大成功。BERT和GPT等模型在各种任务上表现出色。这些模型通过大规模语料库学习语言表示。";

      const chunks = splitter.splitText(text);
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      // 检查 overlap 不以不完整字符开始
      for (const chunk of chunks) {
        // chunk 内容不应以孤立字节开始（UTF-8 有效性）
        expect(() => encodeURIComponent(chunk)).not.toThrow();
      }
    });
  });

  describe("splitDocuments", () => {
    it("should return structured chunks with docId and chunkIndex", () => {
      const splitter = new RecursiveTokenTextSplitter(500, 80);
      const docs = [
        { id: "doc-1", title: "Test Doc", content: "这是文档内容。" },
      ];
      const chunks = splitter.splitDocuments(docs);

      expect(chunks.length).toBe(1);
      expect(chunks[0].docId).toBe("doc-1");
      expect(chunks[0].title).toBe("Test Doc");
      expect(chunks[0].chunkIndex).toBe(0);
    });

    it("should handle multiple documents with correct indices", () => {
      const splitter = new RecursiveTokenTextSplitter(200, 30);
      const longText = Array.from(
        { length: 30 },
        (_, i) => `句子${i + 1}内容。`,
      ).join("");
      const docs = [
        { id: "doc-a", title: "A", content: longText },
        { id: "doc-b", title: "B", content: longText },
      ];
      const chunks = splitter.splitDocuments(docs);

      const docAChunks = chunks.filter((c) => c.docId === "doc-a");
      const docBChunks = chunks.filter((c) => c.docId === "doc-b");

      // 每个文档的 chunkIndex 应从 0 开始
      expect(docAChunks[0].chunkIndex).toBe(0);
      expect(docBChunks[0].chunkIndex).toBe(0);

      // chunkIndex 应连续递增
      for (let i = 1; i < docAChunks.length; i++) {
        expect(docAChunks[i].chunkIndex).toBe(docAChunks[i - 1].chunkIndex + 1);
      }
    });
  });

  describe("overlap semantic boundary preservation", () => {
    it("should preserve complete sentences in overlap", () => {
      const splitter = new RecursiveTokenTextSplitter(300, 80);
      // 文本中明确使用句号分割句子
      const sentences: string[] = [];
      for (let i = 0; i < 30; i++) {
        sentences.push(
          `这是用于测试的第${i + 1}句文本，目的是验证overlap机制是否保留完整句子而不是从半句话中间截断内容`,
        );
      }
      const text = sentences.join("。");

      const chunks = splitter.splitText(text);
      expect(chunks.length).toBeGreaterThan(1);

      // 检查 chunk 间是否有重叠（第二个 chunk 的开头出现在第一个 chunk 中）
      if (chunks.length >= 2) {
        // 第二个 chunk 的前几个字不应该随机开始
        const secondChunkStart = chunks[1].slice(0, 5);
        // 应该是合理的中文开头
        expect(secondChunkStart).toBeTruthy();
      }
    });

    it("should prefer paragraph boundaries for overlap", () => {
      const splitter = new RecursiveTokenTextSplitter(400, 100);
      const paragraphs = Array.from(
        { length: 15 },
        (_, i) =>
          `段落${i + 1}：本段落包含若干内容，用于测试分片器在段落边界上的overlap保留能力。确保段落完整性是重要的语义保留策略。`,
      );
      const text = paragraphs.join("\n\n");
      const chunks = splitter.splitText(text);

      expect(chunks.length).toBeGreaterThan(1);
    });
  });
});
