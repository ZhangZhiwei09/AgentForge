// CitationVerifier 单元测试
//
// 覆盖：
//   - verify() embedding 语义对齐路径（全引用 / 部分不可引用）
//   - verify() keyword 回退路径（全引用 / 无引用）
//   - verify() 边界场景（空 KB / 空响应 / 中英混合）
//   - CitationReport / CitationSentence 结构合约
//   - getCitationVerifier() 单例 & invalidateCitationCache()

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────

vi.mock("@agentforge/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../embeddings.js", () => ({
  getDefaultEmbeddingProvider: vi.fn(),
}));

import {
  CitationVerifier,
  getCitationVerifier,
  invalidateCitationCache,
} from "../citation-verifier.js";
import type { CitationReport, CitationSentence } from "../citation-verifier.js";
import { getDefaultEmbeddingProvider } from "../../embeddings.js";
import type { EmbeddingProvider } from "../../embeddings.js";

// ── Helpers ─────────────────────────────────────────────────

/** KB 参考向量：与任意向量做余弦相似度时，结果取决于对方向量在 x 轴的投影 */
const KB_REF_VECTOR = Object.freeze([1, 0, 0]) as number[];

/** EmbeddingProvider 工厂：根据文本内容返回预设向量 */
function createMockProvider(
  vectorMap: Record<string, number[]>,
): EmbeddingProvider {
  const embed = async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => {
      for (const [key, vec] of Object.entries(vectorMap)) {
        if (t.includes(key)) return vec;
      }
      return [0, 0, 0];
    });

  return {
    dimension: 3,
    modelName: "test-model",
    embed: vi.fn(embed),
    embedSingle: vi.fn(async (text: string) => {
      for (const [key, vec] of Object.entries(vectorMap)) {
        if (text.includes(key)) return vec;
      }
      return [0, 0, 0];
    }),
  };
}

function setupEmbeddingEnv(vectorMap: Record<string, number[]>): EmbeddingProvider {
  const provider = createMockProvider(vectorMap);
  vi.mocked(getDefaultEmbeddingProvider).mockReturnValue(provider);
  return provider;
}

function setupKeywordFallbackEnv(): void {
  // 模拟无 embedding provider：getDefaultEmbeddingProvider 抛错
  vi.mocked(getDefaultEmbeddingProvider).mockImplementation(() => {
    throw new Error("No embedding provider available");
  });
}

// ── Tests ──────────────────────────────────────────────────

describe("CitationVerifier", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ═══════════════════════════════════════════════
  // verify() — embedding 语义对齐路径
  // ═══════════════════════════════════════════════

  describe("verify() — embedding path", () => {
    it("所有事实性句子均被引用时应返回 level=embedding, coverageRate=1.0", async () => {
      // 两个句子分别通过"匹配"和"部署"关键词匹配到高相似度向量
      // KB 使用参考向量 [1,0,0]，高相似度向量在 x 轴投影 ≈0.92~0.97
      setupEmbeddingEnv({
        KB: KB_REF_VECTOR,
        "匹配": [0.95, 0.2, 0.15],
        "部署": [0.92, 0.25, 0.2],
      });

      const verifier = new CitationVerifier();
      const report = await verifier.verify(
        "这个配置匹配。这个部署需要3个配置。",
        ["KB:部署流程需要3个实例"],
      );

      expect(report.level).toBe("embedding");
      expect(report.coverageRate).toBe(1.0);
      expect(report.weakSentenceIndices).toHaveLength(0);
      // 所有事实性句子均为 cited
      const factual = report.sentences.filter((s) => s.isFactual);
      expect(factual.length).toBeGreaterThan(0);
      expect(factual.every((s) => s.status === "cited")).toBe(true);
    });

    it("部分句子不可引用时应记录 weakSentenceIndices", async () => {
      // "高匹配" → 高相似度 (≈0.97)  → cited
      // "低相关" → 低相似度 (≈0.11)  → uncited
      setupEmbeddingEnv({
        KB: KB_REF_VECTOR,
        "高匹配": [0.95, 0.2, 0.15],
        "低相关": [0.1, 0.9, 0.2],
      });

      const verifier = new CitationVerifier();
      const report = await verifier.verify(
        "这个配置高匹配。这个配置低相关。",
        ["KB:部署流程"],
      );

      expect(report.level).toBe("embedding");
      expect(report.coverageRate).toBeLessThan(1.0);
      expect(report.weakSentenceIndices.length).toBeGreaterThan(0);

      const weakSentences = report.sentences.filter(
        (s) => s.status === "uncited" || s.status === "weak_citation",
      );
      expect(weakSentences.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════
  // verify() — keyword 回退路径
  // ═══════════════════════════════════════════════

  describe("verify() — keyword fallback path", () => {
    it("无 KB chunks 时应返回空报告（empty report）", async () => {
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      const report = await verifier.verify("部署时需要5个实例。", []);

      expect(report.coverageRate).toBe(0);
      expect(report.avgScore).toBe(0);
      expect(report.level).toBe("keyword_fallback");
      // 事实性句子在空 KB 场景下全部标记为 uncited
      const factual = report.sentences.filter((s) => s.isFactual);
      expect(factual.every((s) => s.status === "uncited")).toBe(true);
    });

    it("空响应文本应正常处理不抛错", async () => {
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      const report = await verifier.verify("", ["KB: reference content"]);

      expect(report.sentences).toHaveLength(0);
      expect(report.coverageRate).toBe(0);
      expect(report.avgScore).toBe(0);
      expect(() => report).not.toThrow;
    });

    it("有事实性声明但 KB 无匹配关键词时应标记为 uncited", async () => {
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      // 句子含关键词"部署""实例"；KB 无任何重叠实体
      const report = await verifier.verify(
        "部署时需要5个实例。",
        ["天气晴朗适合出行。"],
      );

      const factual = report.sentences.filter((s) => s.isFactual);
      expect(factual.length).toBeGreaterThan(0);
      // 无关键词重叠 → keywordCitationScore 应低于 uncited 阈值
      expect(factual.every((s) => s.status === "uncited")).toBe(true);
    });

    it("所有事实性声明均有 KB 关键词支撑时应全部 cited", async () => {
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      // 句子与 KB 共享关键词"部署""实例" → 关键词重叠分数 ≥ 0.55 → cited
      const report = await verifier.verify(
        "部署时需要5个实例。",
        ["部署流程需要最少3个实例。"],
      );

      const factual = report.sentences.filter((s) => s.isFactual);
      expect(factual.length).toBeGreaterThan(0);
      expect(factual.every((s) => s.status === "cited")).toBe(true);
      expect(report.level).toBe("keyword_fallback");
      expect(report.coverageRate).toBe(1.0);
    });

    it("中英混合文本应正常处理不抛错", async () => {
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      const report = await verifier.verify(
        "Hello! This is a greeting. 部署时需要5个实例。",
        ["部署流程需要最少3个实例。"],
      );

      // 英文寒暄句应为非事实性（不命中中文事实指示器）
      const nonFactual = report.sentences.filter((s) => !s.isFactual);
      const factual = report.sentences.filter((s) => s.isFactual);

      expect(
        nonFactual.length,
        "英文寒暄句应判定为非事实性",
      ).toBeGreaterThan(0);
      expect(factual.length, "中文事实句应被识别").toBeGreaterThan(0);
      // 非事实性句子状态应为 cited（无需验证）
      expect(nonFactual.every((s) => s.status === "cited")).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════
  // CitationReport 结构合约
  // ═══════════════════════════════════════════════

  describe("CitationReport 结构合约", () => {
    it("应包含 level, coverageRate, avgScore, sentences, weakSentenceIndices", async () => {
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      const report = await verifier.verify(
        "部署时需要5个实例。",
        ["部署流程"],
      );

      // 顶层字段
      expect(report).toHaveProperty("level");
      expect(["embedding", "keyword_fallback"]).toContain(report.level);
      expect(typeof report.coverageRate).toBe("number");
      expect(report.coverageRate).toBeGreaterThanOrEqual(0);
      expect(report.coverageRate).toBeLessThanOrEqual(1);
      expect(typeof report.avgScore).toBe("number");
      expect(report.avgScore).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(report.sentences)).toBe(true);
      expect(Array.isArray(report.weakSentenceIndices)).toBe(true);
    });

    it("每个句子条目应包含 text, isFactual, status, bestChunkIndex, bestChunkPreview", async () => {
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      const report = await verifier.verify(
        "部署时需要5个实例。",
        ["部署流程"],
      );

      expect(report.sentences.length).toBeGreaterThan(0);

      for (const sent of report.sentences) {
        expect(sent).toHaveProperty("text");
        expect(typeof sent.text).toBe("string");
        expect(sent).toHaveProperty("isFactual");
        expect(typeof sent.isFactual).toBe("boolean");
        expect(sent).toHaveProperty("status");
        expect(["cited", "weak_citation", "uncited"]).toContain(sent.status);
        expect(sent).toHaveProperty("bestScore");
        expect(typeof sent.bestScore).toBe("number");
        expect(sent).toHaveProperty("bestChunkIndex");
        expect(typeof sent.bestChunkIndex).toBe("number");
        expect(sent).toHaveProperty("bestChunkPreview");
        expect(typeof sent.bestChunkPreview).toBe("string");
      }
    });
  });

  // ═══════════════════════════════════════════════
  // 单例与缓存管理
  // ═══════════════════════════════════════════════

  describe("getCitationVerifier() 单例", () => {
    it("多次调用应返回同一个实例", () => {
      const a = getCitationVerifier();
      const b = getCitationVerifier();

      expect(a).toBe(b);
      expect(a).toBeInstanceOf(CitationVerifier);
    });

    it("invalidateCitationCache() 应清除 cache", () => {
      const verifier = getCitationVerifier();
      expect(verifier.cacheSize).toBeGreaterThanOrEqual(0);

      invalidateCitationCache();
      // 清除后缓存容量应为 0
      expect(verifier.cacheSize).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════
  // 边界 & 回归
  // ═══════════════════════════════════════════════

  describe("边界场景", () => {
    it("仅含非事实性句子时 coverageRate 为 NaN 时应不抛错", async () => {
      // 纯寒暄文本 → 所有句子非事实性 → factualCount=0 → effectiveCount=1
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      const report = await verifier.verify("你好！感谢您的支持。", [
        "部署流程",
      ]);

      // 非事实性句子状态均为 cited
      expect(report.sentences.every((s) => s.status === "cited")).toBe(true);
      expect(report.sentences.every((s) => !s.isFactual)).toBe(true);
    });

    it("KB chunks 中包含多段内容时应逐段计算最佳匹配", async () => {
      // 两段 KB，一段匹配关键词，一段不匹配
      setupKeywordFallbackEnv();

      const verifier = new CitationVerifier();
      const report = await verifier.verify(
        "部署时需要5个实例。",
        ["天气晴朗。", "部署流程需要最少3个实例。"],
      );

      const factual = report.sentences.filter((s) => s.isFactual);
      expect(factual.length).toBeGreaterThan(0);
      // 第二段 KB 应与句子关键词重叠 → cited
      expect(factual[0].status).toBe("cited");
      // 最佳匹配应指向第二段（含关键词），预览非空
      expect(factual[0].bestChunkIndex).toBeGreaterThanOrEqual(0);
      expect(factual[0].bestChunkPreview.length).toBeGreaterThan(0);
    });

    it("embedding 批量调用失败后应通过 embedSingle 逐条重试完成验证", async () => {
      // verifyWithEmbeddings 内部有双层降级：batch embed 失败 → embedSingle 逐条重试
      // embedSingle 失败 → zero-vector 兜底。整个流程不会抛出，level 仍为 embedding。
      const provider = createMockProvider({ KB: KB_REF_VECTOR, "部署": [0.92, 0.25, 0.2] });
      // 仅让 batch embed 失败，embedSingle 正常返回
      vi.mocked(provider.embed).mockRejectedValue(
        new Error("Embedding batch failure"),
      );
      vi.mocked(getDefaultEmbeddingProvider).mockReturnValue(provider);

      const verifier = new CitationVerifier();
      const report = await verifier.verify(
        "部署时需要5个实例。",
        ["KB:部署流程"],
      );

      // 批量失败后逐条重试成功，level 仍为 embedding
      expect(report.level).toBe("embedding");
      expect(report.coverageRate).toBe(1.0);
      // embedSingle 被调用（逐条重试 KB chunks 和句子）
      expect(provider.embedSingle).toHaveBeenCalled();
      // 结果正确：事实性句子被引用
      const factual = report.sentences.filter((s) => s.isFactual);
      expect(factual.every((s) => s.status === "cited")).toBe(true);
    });
  });
});
