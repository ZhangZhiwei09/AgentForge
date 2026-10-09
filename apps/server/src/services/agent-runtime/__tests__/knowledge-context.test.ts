// KnowledgeContextBuilder 单元测试
//
// 覆盖：
//   - build() 正常 KB 结果 → 结构化 KnowledgeContext
//   - docs / citations 字段结构验证
//   - 置信度分档计算（top_score 阈值）
//   - malformed JSON → null（不抛异常）
//   - 空结果 / 缺失字段 → 优雅降级
//   - userQuery 参与覆盖缺口识别
//   - 去重 + 排序 + 上限截断
//   - 真实场景 search_knowledge_base 响应

import { describe, it, expect, vi } from "vitest";
import { KnowledgeContextBuilder, toCitationCards } from "../knowledge-context.js";
import type { KnowledgeContext } from "../types.js";

// ── Mock logger（hoisted）──

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("@agentforge/logger", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      warn: mockLoggerWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

// ── 辅助工具 ──

/** 构造一个合法的 RawKBToolOutput JSON 字符串 */
function makeToolOutput(overrides: Record<string, unknown> = {}): string {
  const defaults = {
    query: "测试查询",
    found: true,
    top_score: 0.85,
    results: [
      {
        content: "这是第一条检索结果，包含关于产品退换货政策的详细说明。",
        score: 0.92,
        source: "退换货政策",
      },
      {
        content: "第二条结果，说明退款流程和到账时间。",
        score: 0.78,
        source: "退款流程",
      },
      {
        content: "第三条结果，关于售后服务的联系方式。",
        score: 0.65,
        source: "售后服务",
      },
    ],
  };
  return JSON.stringify({ ...defaults, ...overrides });
}

/** 构造单条 RawKBResult */
function makeResult(
  content: string,
  score: number,
  source: string,
): { content: string; score: number; source: string } {
  return { content, score, source };
}

// ═══════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════

describe("KnowledgeContextBuilder", () => {
  const builder = new KnowledgeContextBuilder();

  describe("build() — valid input", () => {
    it("valid KB tool result → returns structured KnowledgeContext", () => {
      const output = makeToolOutput();
      const result = builder.build(output, "退换货政策咨询");

      expect(result).not.toBeNull();
      expect(result!.docs).toBeInstanceOf(Array);
      expect(result!.citations).toBeInstanceOf(Array);
      expect(typeof result!.confidence).toBe("number");
      expect(result!.gaps).toBeInstanceOf(Array);
      expect(typeof result!.summary).toBe("string");
    });

    it("extracted docs have title, content, score fields", () => {
      const output = makeToolOutput();
      const result = builder.build(output, "测试");

      expect(result).not.toBeNull();
      for (const doc of result!.docs) {
        expect(doc).toHaveProperty("id");
        expect(doc).toHaveProperty("title");
        expect(doc).toHaveProperty("content");
        expect(typeof doc.id).toBe("string");
      }
      for (const citation of result!.citations) {
        expect(citation).toHaveProperty("docId");
        expect(citation).toHaveProperty("docTitle");
        expect(citation).toHaveProperty("chunkIndex");
        expect(citation).toHaveProperty("content");
        expect(citation).toHaveProperty("score");
        expect(typeof citation.score).toBe("number");
        expect(typeof citation.docId).toBe("string");
      }
    });

    it("KnowledgeContext has docs array and confidence number", () => {
      const output = makeToolOutput();
      const result = builder.build(output, "测试");

      expect(result).not.toBeNull();
      const ctx = result as KnowledgeContext;
      expect(Array.isArray(ctx.docs)).toBe(true);
      expect(typeof ctx.confidence).toBe("number");
      expect(ctx.confidence).toBeGreaterThanOrEqual(0);
      expect(ctx.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe("build() — confidence calculation", () => {
    it("does not interpret an RRF ranking score as semantic relevance", () => {
      const result = builder.build(
        makeToolOutput({
          score_type: "rrf",
          top_score: 0.0164,
          top_relevance_score: null,
          results: [{
            content: "退款流程",
            source: "退款政策",
            score: 0.0164,
            scoreType: "rrf",
          }],
        }),
        "退款流程",
      );
      expect(result!.confidence).toBe(0.3);
      expect(result!.gaps).not.toContain("检索结果整体相关度偏低");
      expect(result!.summary).toContain("综合排序分: 0.0164");
    });

    it("uses the reranker relevance score for confidence", () => {
      const result = builder.build(
        makeToolOutput({
          score_type: "reranker",
          top_score: 0.0164,
          top_relevance_score: 0.9,
        }),
        "测试",
      );
      expect(result!.confidence).toBe(0.9);
    });

    it("preserves score metadata in citations and protocol cards", () => {
      const metadata = {
        score: 0.91,
        scoreType: "reranker",
        sourceScore: 0.8,
        fusionScore: 0.0164,
        rerankScore: 0.91,
      };
      const result = builder.build(
        makeToolOutput({
          results: [{
            docId: "doc-1",
            chunkIndex: 3,
            content: "退款流程",
            source: "退款政策",
            ...metadata,
          }],
        }),
        "退款流程",
      );
      expect(result!.citations[0]).toMatchObject(metadata);
      expect(toCitationCards(result!.citations)[0]).toMatchObject({
        docId: "doc-1",
        index: 1,
        ...metadata,
      });
      expect(result!.summary).toContain("Rerank 分: 0.9100");
    });

    it("top_score >= 0.8 → confidence 0.9", () => {
      const result = builder.build(
        makeToolOutput({ top_score: 0.85 }),
        "测试",
      );
      expect(result!.confidence).toBe(0.9);
    });

    it("top_score >= 0.65 → confidence 0.7", () => {
      const result = builder.build(
        makeToolOutput({ top_score: 0.72 }),
        "测试",
      );
      expect(result!.confidence).toBe(0.7);
    });

    it("top_score >= 0.5 → confidence 0.5", () => {
      const result = builder.build(
        makeToolOutput({ top_score: 0.55 }),
        "测试",
      );
      expect(result!.confidence).toBe(0.5);
    });

    it("top_score < 0.5 → confidence 0.3", () => {
      const result = builder.build(
        makeToolOutput({ top_score: 0.32 }),
        "测试",
      );
      expect(result!.confidence).toBe(0.3);
    });

    it("top_score 0 → confidence 0.3", () => {
      const result = builder.build(
        makeToolOutput({ top_score: 0 }),
        "测试",
      );
      expect(result!.confidence).toBe(0.3);
    });
  });

  describe("build() — error handling", () => {
    it("malformed JSON tool result → returns null (no crash)", () => {
      const result = builder.build("not valid json {{{", "测试");
      expect(result).toBeNull();
      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it("empty string → returns null", () => {
      const result = builder.build("", "测试");
      expect(result).toBeNull();
    });

    it("null-like string → returns null", () => {
      const result = builder.build("null", "测试");
      // JSON.parse("null") = null, accessing .found throws TypeError → caught → null
      expect(result).toBeNull();
    });

    it("JSON array instead of object → returns null", () => {
      const result = builder.build("[]", "测试");
      // JSON.parse("[]") = [], !parsed.found is true → null
      expect(result).toBeNull();
    });
  });

  describe("build() — missing fields", () => {
    it('tool result with missing "found" field → returns null', () => {
      const obj = {
        query: "测试",
        top_score: 0.8,
        results: [makeResult("内容", 0.9, "来源")],
      };
      const result = builder.build(JSON.stringify(obj), "测试");
      expect(result).toBeNull();
    });

    it('tool result with missing "results" field → returns null', () => {
      const obj = {
        query: "测试",
        found: true,
        top_score: 0.8,
        // results missing
      };
      const result = builder.build(JSON.stringify(obj), "测试");
      expect(result).toBeNull();
    });

    it('tool result with "results" as non-array → returns null', () => {
      const obj = {
        query: "测试",
        found: true,
        top_score: 0.8,
        results: "not an array",
      };
      const result = builder.build(JSON.stringify(obj), "测试");
      expect(result).toBeNull();
    });

    it("found=false → returns null even with valid results", () => {
      const output = makeToolOutput({ found: false });
      const result = builder.build(output, "测试");
      expect(result).toBeNull();
    });

    it("found=true with empty results → returns context with empty docs", () => {
      const output = makeToolOutput({ results: [] });
      const result = builder.build(output, "测试");
      expect(result).not.toBeNull();
      expect(result!.docs).toHaveLength(0);
      expect(result!.citations).toHaveLength(0);
    });
  });

  describe("build() — deduplication & sorting", () => {
    it("deduplicates results with identical first-100-chars content", () => {
      const sameContent = "A".repeat(200);
      const output = makeToolOutput({
        found: true,
        top_score: 0.9,
        results: [
          { content: sameContent, score: 0.9, source: "源A" },
          { content: sameContent, score: 0.7, source: "源B" }, // duplicate
          { content: "different content here", score: 0.5, source: "源C" },
        ],
      });
      const result = builder.build(output, "测试");
      expect(result).not.toBeNull();
      // 2 unique docs (the first occurrence of sameContent + the different one)
      expect(result!.docs).toHaveLength(2);
      expect(result!.citations).toHaveLength(2);
    });

    it("sorts results by score descending", () => {
      const output = makeToolOutput({
        found: true,
        top_score: 0.95,
        results: [
          { content: "低分内容 A", score: 0.5, source: "源A" },
          { content: "高分内容 B", score: 0.95, source: "源B" },
          { content: "中分内容 C", score: 0.72, source: "源C" },
        ],
      });
      const result = builder.build(output, "测试");

      expect(result).not.toBeNull();
      const scores = result!.citations.map((c) => c.score);
      expect(scores).toEqual([0.95, 0.72, 0.5]);
    });

    it("caps results at MAX_DOCS (10)", () => {
      const manyResults = Array.from({ length: 15 }, (_, i) => ({
        content: `内容 ${i}`.padEnd(50, `${i}`),
        score: 0.9 - i * 0.02,
        source: `源${i}`,
      }));
      const output = makeToolOutput({
        found: true,
        top_score: 0.9,
        results: manyResults,
      });
      const result = builder.build(output, "测试");
      expect(result).not.toBeNull();
      expect(result!.docs.length).toBeLessThanOrEqual(10);
      expect(result!.citations.length).toBeLessThanOrEqual(10);
    });
  });

  describe("build() — gap identification", () => {
    it("identifies query terms not found in doc contents", () => {
      const output = makeToolOutput({
        found: true,
        top_score: 0.8,
        results: [
          makeResult("关于物流配送的说明", 0.9, "物流政策"),
        ],
      });
      const result = builder.build(
        output,
        "我想了解退款政策的具体流程",
      );

      expect(result).not.toBeNull();
      // "退款" should not be in the doc content
      const refundGap = result!.gaps.find((g) => g.includes("退款"));
      expect(refundGap).toBeDefined();
    });

    it("reports low-relevance warning when few docs with low scores", () => {
      const output = makeToolOutput({
        found: true,
        top_score: 0.4,
        results: [
          makeResult("相关性较低的内容", 0.3, "来源A"),
        ],
      });
      const result = builder.build(output, "精确查询关键词");

      expect(result).not.toBeNull();
      expect(result!.gaps.some((g) => g.includes("相关度偏低"))).toBe(true);
    });

    it("does not report low-relevance warning when 3+ docs", () => {
      const output = makeToolOutput({
        found: true,
        top_score: 0.4,
        results: [
          makeResult("内容A", 0.3, "A"),
          makeResult("内容B", 0.35, "B"),
          makeResult("内容C", 0.2, "C"),
        ],
      });
      const result = builder.build(output, "测试查询");

      expect(result).not.toBeNull();
      expect(result!.gaps.some((g) => g.includes("相关度偏低"))).toBe(false);
    });

    it("caps gaps at 5 entries", () => {
      // Create docs that don't cover any of the query terms
      const output = makeToolOutput({
        found: true,
        top_score: 0.8,
        results: [
          makeResult("完全不相关的文档内容", 0.9, "无关来源"),
        ],
      });
      // This query has many 2+ char terms that won't match
      const result = builder.build(output, "退款 物流 售后 保修 发票 换货 会员 积分");
      expect(result).not.toBeNull();
      expect(result!.gaps.length).toBeLessThanOrEqual(5);
    });
  });

  describe("build() — summary generation", () => {
    it("includes confidence, top score, and doc count in summary", () => {
      const result = builder.build(makeToolOutput(), "测试");
      expect(result).not.toBeNull();
      expect(result!.summary).toContain("检索置信度");
      expect(result!.summary).toContain("最佳匹配分数");
      expect(result!.summary).toContain("结果数");
    });

    it("includes content previews when docs exist", () => {
      const result = builder.build(makeToolOutput(), "测试");
      expect(result).not.toBeNull();
      expect(result!.summary).toContain("相关内容摘要");
    });

    it("includes gap information when gaps exist", () => {
      const output = makeToolOutput({
        results: [makeResult("无关内容", 0.9, "源")],
        top_score: 0.9,
      });
      const result = builder.build(output, "退款流程咨询");
      expect(result).not.toBeNull();
      expect(result!.summary).toContain("覆盖缺口");
    });

    it("includes low-confidence warning when confidence < 0.5", () => {
      const result = builder.build(
        makeToolOutput({ top_score: 0.3 }),
        "测试",
      );
      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.3);
      expect(result!.summary).toContain("检索置信度较低");
    });

    it("truncates doc previews longer than 150 chars", () => {
      const longContent = "X".repeat(200);
      const result = builder.build(
        makeToolOutput({
          results: [makeResult(longContent, 0.9, "长文档")],
          top_score: 0.9,
        }),
        "测试",
      );
      expect(result).not.toBeNull();
      // The preview should contain "..." for truncated content
      expect(result!.summary).toContain("...");
    });
  });

  describe("build() — realistic scenario", () => {
    it("handles a realistic search_knowledge_base response", () => {
      const realisticOutput = JSON.stringify({
        query: "我的订单什么时候发货",
        found: true,
        quality: "high",
        top_score: 0.94,
        results: [
          {
            content:
              "通常情况下，订单支付成功后会在1-3个工作日内发货。如遇促销活动期间，发货时间可能延长至5-7个工作日。您可以在订单详情页查看实时物流状态。",
            score: 0.94,
            source: "发货时效说明",
          },
          {
            content:
              "物流信息查询方法：登录账户 → 进入「我的订单」→ 点击对应订单 → 查看物流详情。支持顺丰、中通、圆通等多家快递公司。",
            score: 0.88,
            source: "物流查询指南",
          },
          {
            content:
              "如超过预计发货时间仍未发货，请联系在线客服或拨打客服热线 400-xxx-xxxx，我们将尽快为您处理。",
            score: 0.75,
            source: "延迟发货处理",
          },
          {
            content:
              "海外订单发货时效一般为7-15个工作日，具体取决于目的地国家和清关速度。",
            score: 0.62,
            source: "国际物流说明",
          },
          {
            content:
              "退换货政策：自签收之日起7天内可申请无理由退货，15天内可申请换货。请确保商品完好不影响二次销售。",
            score: 0.48,
            source: "退换货政策",
          },
        ],
        message: "找到 5 条相关结果",
      });

      const result = builder.build(realisticOutput, "我的订单什么时候发货");

      // 基础结构验证
      expect(result).not.toBeNull();
      expect(result!.docs).toHaveLength(5);
      expect(result!.citations).toHaveLength(5);
      expect(result!.confidence).toBe(0.9); // top_score 0.94 >= 0.8

      // docs 字段验证
      for (const doc of result!.docs) {
        expect(doc.id).toBeTruthy();
        expect(doc.title).toBeTruthy();
        expect(doc.content.length).toBeGreaterThan(0);
      }

      // citations 字段验证
      let lastScore = Infinity;
      for (const citation of result!.citations) {
        expect(citation.docId).toMatch(/^kb-\d+$/);
        expect(citation.docTitle).toBeTruthy();
        expect(citation.content.length).toBeGreaterThan(0);
        expect(citation.score).toBeGreaterThan(0);
        expect(citation.score).toBeLessThanOrEqual(1);
        // 验证按分降序
        expect(citation.score).toBeLessThanOrEqual(lastScore);
        lastScore = citation.score;
      }

      // confidence 是两位小数的数值
      expect(result!.confidence).toBe(0.9);

      // summary 包含关键信息
      expect(result!.summary).toContain("检索置信度: 90%");
      expect(result!.summary).toContain("最佳匹配分数: 0.94");
      expect(result!.summary).toContain("结果数: 5");
      expect(result!.summary).toContain("相关内容摘要");
      expect(result!.summary).toContain("发货时效说明");
      expect(result!.summary).toContain("物流查询指南");

      // gaps: 查询中的 "订单"、"发货" 等词在结果中普遍存在，不应产生大量缺口
      // 但 "时候" 是单字，不匹配 [一-鿿\w]{2,} 正则
      expect(result!.gaps.length).toBeLessThanOrEqual(5);
    });
  });
});
