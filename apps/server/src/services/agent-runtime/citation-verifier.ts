// CitationVerifier —— 逐句语义引证校验
//
// 替代原有的 L4 关键词重叠检测，实现 citation-based verification：
//   1. 将 LLM 回复拆分为事实性句子
//   2. 逐句与 KB chunks 做 embedding 相似度计算
//   3. 输出每句的引证分数，标记无来源支撑的句子
//
// 降级策略：embedding provider 不可用时，回退到增强版关键词+实体匹配
//
// Phase 2 规划：引入 BGE-reranker 对 top-3 chunks 做精排

import { logger } from "@agentforge/logger";
import { getDefaultEmbeddingProvider } from "../embeddings.js";
import type { EmbeddingProvider } from "../embeddings.js";

// ── 类型定义 ──

export interface CitationSentence {
  /** 句子原文 */
  text: string;
  /** 是否为事实性句子（含数字、政策关键词等） */
  isFactual: boolean;
  /** 与最佳匹配 KB chunk 的余弦相似度 */
  bestScore: number;
  /** 最佳匹配的 KB chunk 索引 */
  bestChunkIndex: number;
  /** 最佳匹配的 KB chunk 摘要（前100字符） */
  bestChunkPreview: string;
  /** 该句子的引证状态 */
  status: "cited" | "weak_citation" | "uncited";
}

export interface CitationReport {
  /** 逐句引证结果 */
  sentences: CitationSentence[];
  /** 总体引证覆盖率（有来源支撑的句子占比） */
  coverageRate: number;
  /** 平均引证分数 */
  avgScore: number;
  /** 验证级别：embedding=语义对齐，keyword=关键词回退 */
  level: "embedding" | "keyword_fallback";
  /** 弱引证/无引证的句子索引列表 */
  weakSentenceIndices: number[];
}

// ── 配置常量 ──

/** embedding 余弦相似度阈值：低于此值视为弱引证 */
const EMBEDDING_CITATION_THRESHOLD = 0.7;

/** 弱引证阈值：低于此值视为完全无引证 */
const EMBEDDING_UNCITED_THRESHOLD = 0.55;

/** 事实性指示器 —— 句子包含这些模式时，判定为事实性声明，必须验证 */
const FACTUAL_INDICATORS: RegExp[] = [
  /[0-9]+\s*(天|个工作日|小时|分钟|元|块|%|次|条|项)/,
  /(策略|配置|部署|监控|错误|告警|状态|版本|实例|节点)/,
  /(用户|权限|角色|审批|流程|规则|工单|任务)/,
  /(必须|需要|应当|可以|允许|禁止|不得|不支持)/,
  /(文档|说明|指南|规范|标准|要求|条件)/,
];

/** 非事实性句子模式 —— 这些句子不需要引证 */
const NON_FACTUAL_PATTERNS: RegExp[] = [
  /^(你好|您好|Hi|Hello|感谢|谢谢|不客气|再见|拜拜)/i,
  /^(有什么|请问|能否|是否可以)/,
  /^(很高兴|欢迎|祝您|希望)/,
  /^(如果.*可以|如需.*联系|请.*稍等)/,
  /^[^一-鿿\w]*$/, // 纯标点/空白
];

// ── 余弦相似度计算 ──

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// ── 句子分割（中英文感知） ──

function splitSentences(text: string): string[] {
  // 按中英文句末标点分割，保留分割后的非空句子
  const raw = text
    .split(/(?<=[。！？.!?\n])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 合并过短的片段到前一句
  const merged: string[] = [];
  for (const s of raw) {
    if (s.length < 4 && merged.length > 0) {
      merged[merged.length - 1] += s;
    } else {
      merged.push(s);
    }
  }
  return merged;
}

// ── 事实性判断 ──

function isFactualSentence(sentence: string): boolean {
  // 先排除非事实性模式
  if (NON_FACTUAL_PATTERNS.some((p) => p.test(sentence))) {
    return false;
  }
  // 再检查事实性指示器
  return FACTUAL_INDICATORS.some((p) => p.test(sentence));
}

// ── 增强版关键词+实体回退匹配 ──

interface EntityExtract {
  numbers: string[];
  keywords: string[];
  policyTerms: string[];
}

function extractEntities(text: string): EntityExtract {
  const numbers =
    text.match(/[0-9]+(\s*[天个工作日小时分钟元块次条项%％])?/g) || [];
  const keywords =
    text.match(
      /(策略|配置|部署|监控|错误|告警|状态|版本|实例|节点|用户|权限|角色|审批|流程|规则|工单|任务|文档|说明|指南|规范|标准|要求|条件)/g,
    ) || [];
  const policyTerms =
    text.match(
      /(启用|禁用|重启|升级|回滚|扩容|缩容|迁移|备份|恢复|检查|验证|测试)/g,
    ) || [];

  return { numbers, keywords, policyTerms };
}

function keywordCitationScore(sentence: string, chunkText: string): number {
  const sentEntities = extractEntities(sentence);
  const chunkEntities = extractEntities(chunkText);

  // 数字重叠分数（权重最高 —— 数字不匹配 = 高风险）
  const numberOverlap =
    sentEntities.numbers.length > 0
      ? sentEntities.numbers.filter((n) => chunkEntities.numbers.includes(n))
          .length / sentEntities.numbers.length
      : 1; // 没有数字则不扣分

  // 关键词重叠分数
  const keywordOverlap =
    sentEntities.keywords.length > 0
      ? sentEntities.keywords.filter((k) => chunkEntities.keywords.includes(k))
          .length / sentEntities.keywords.length
      : 0.5;

  // 政策术语重叠
  const policyOverlap =
    sentEntities.policyTerms.length > 0
      ? sentEntities.policyTerms.filter((p) =>
          chunkEntities.policyTerms.includes(p),
        ).length / sentEntities.policyTerms.length
      : 1;

  // 加权综合：数字 40% + 关键词 35% + 术语 25%
  return numberOverlap * 0.4 + keywordOverlap * 0.35 + policyOverlap * 0.25;
}

// ═══════════════════════════════════════════════════════
// CitationVerifier
// ═══════════════════════════════════════════════════════

export class CitationVerifier {
  private static readonly MAX_CACHE_SIZE = 1000;

  private embeddingProvider: EmbeddingProvider | null = null;
  private chunkEmbeddingCache: Map<string, number[]> = new Map();
  private cacheInsertionOrder: string[] = []; // LRU 淘汰队列

  constructor() {
    try {
      this.embeddingProvider = getDefaultEmbeddingProvider();
    } catch {
      logger.info(
        "CitationVerifier: no embedding provider available, using keyword fallback",
      );
    }
  }

  /**
   * 对 LLM 回复进行逐句引证校验
   *
   * @param answerText - LLM 生成的回答文本
   * @param kbChunks - 知识库检索返回的文本 chunk 列表
   * @returns CitationReport - 逐句引证分析报告
   */
  async verify(
    answerText: string,
    kbChunks: string[],
  ): Promise<CitationReport> {
    // 无 KB 时快速返回
    if (kbChunks.length === 0) {
      return this.emptyReport(answerText);
    }

    // 优先使用 embedding 语义对齐
    if (this.embeddingProvider) {
      try {
        return await this.verifyWithEmbeddings(answerText, kbChunks);
      } catch (e) {
        logger.warn(
          e,
          "CitationVerifier: embedding verification failed, falling back to keyword",
        );
      }
    }

    // 回退到增强版关键词匹配
    return this.verifyWithKeywords(answerText, kbChunks);
  }

  // ── Embedding 语义对齐 ──

  private async verifyWithEmbeddings(
    answerText: string,
    kbChunks: string[],
  ): Promise<CitationReport> {
    const sentences = splitSentences(answerText);

    // 批量获取 KB chunk embeddings（带缓存）
    const chunkEmbeddings = await this.getChunkEmbeddings(kbChunks);

    // 获取事实性句子的 embeddings
    const factualIndices: number[] = [];
    const factualSentences: string[] = [];
    sentences.forEach((s, i) => {
      if (isFactualSentence(s)) {
        factualIndices.push(i);
        factualSentences.push(s);
      }
    });

    // 批量 embedding 事实性句子
    let sentenceEmbeddings: number[][] = [];
    if (factualSentences.length > 0) {
      try {
        sentenceEmbeddings =
          await this.embeddingProvider!.embed(factualSentences);
      } catch {
        // 批量失败则逐条重试
        for (const s of factualSentences) {
          try {
            const emb = await this.embeddingProvider!.embedSingle(s);
            sentenceEmbeddings.push(emb);
          } catch {
            // Expected: single embedding may fail — use zero vector as fallback
            sentenceEmbeddings.push(
              new Array(this.embeddingProvider!.dimension).fill(0),
            );
          }
        }
      }
    }

    // 逐句计算最佳匹配
    const sentenceResults: CitationSentence[] = [];
    let totalFactualScore = 0;
    const weakIndices: number[] = [];

    let embIdx = 0;
    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const factual = isFactualSentence(sentence);

      if (!factual) {
        sentenceResults.push({
          text: sentence,
          isFactual: false,
          bestScore: 1.0,
          bestChunkIndex: -1,
          bestChunkPreview: "",
          status: "cited", // 非事实性句子不需要验证
        });
        continue;
      }

      const sentEmb = sentenceEmbeddings[embIdx];
      embIdx++;

      // 与所有 KB chunks 计算余弦相似度
      let bestScore = 0;
      let bestIdx = -1;
      for (let j = 0; j < chunkEmbeddings.length; j++) {
        const score = cosineSimilarity(sentEmb, chunkEmbeddings[j]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }

      totalFactualScore += bestScore;

      let status: CitationSentence["status"];
      if (bestScore >= EMBEDDING_CITATION_THRESHOLD) {
        status = "cited";
      } else if (bestScore >= EMBEDDING_UNCITED_THRESHOLD) {
        status = "weak_citation";
        weakIndices.push(i);
      } else {
        status = "uncited";
        weakIndices.push(i);
      }

      sentenceResults.push({
        text: sentence,
        isFactual: true,
        bestScore: Math.round(bestScore * 1000) / 1000,
        bestChunkIndex: bestIdx,
        bestChunkPreview: bestIdx >= 0 ? kbChunks[bestIdx].slice(0, 100) : "",
        status,
      });
    }

    const factualCount = factualIndices.length || 1;
    const coverageRate =
      sentenceResults.filter((s) => s.isFactual && s.status === "cited")
        .length / factualCount;

    return {
      sentences: sentenceResults,
      coverageRate: Math.round(coverageRate * 1000) / 1000,
      avgScore: Math.round((totalFactualScore / factualCount) * 1000) / 1000,
      level: "embedding",
      weakSentenceIndices: weakIndices,
    };
  }

  // ── 增强版关键词回退 ──

  private verifyWithKeywords(
    answerText: string,
    kbChunks: string[],
  ): CitationReport {
    const sentences = splitSentences(answerText);
    const sentenceResults: CitationSentence[] = [];
    const weakIndices: number[] = [];
    let totalFactualScore = 0;
    let factualCount = 0;

    // KB 全文合并用于回退匹配
    const kbFullText = kbChunks.join("\n");

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const factual = isFactualSentence(sentence);

      if (!factual) {
        sentenceResults.push({
          text: sentence,
          isFactual: false,
          bestScore: 1.0,
          bestChunkIndex: -1,
          bestChunkPreview: "",
          status: "cited",
        });
        continue;
      }

      factualCount++;

      // 对每个 KB chunk 计算增强关键词分数
      let bestScore = 0;
      let bestIdx = -1;
      for (let j = 0; j < kbChunks.length; j++) {
        const score = keywordCitationScore(sentence, kbChunks[j]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }

      // 在回退模式下，阈值调低（因为关键词匹配本身就更弱）
      const adjustedThreshold = EMBEDDING_CITATION_THRESHOLD - 0.15; // 0.55
      const adjustedUncited = EMBEDDING_UNCITED_THRESHOLD - 0.15; // 0.40

      totalFactualScore += bestScore;

      let status: CitationSentence["status"];
      if (bestScore >= adjustedThreshold) {
        status = "cited";
      } else if (bestScore >= adjustedUncited) {
        status = "weak_citation";
        weakIndices.push(i);
      } else {
        status = "uncited";
        weakIndices.push(i);
      }

      sentenceResults.push({
        text: sentence,
        isFactual: true,
        bestScore: Math.round(bestScore * 1000) / 1000,
        bestChunkIndex: bestIdx,
        bestChunkPreview: bestIdx >= 0 ? kbChunks[bestIdx].slice(0, 100) : "",
        status,
      });
    }

    const effectiveCount = factualCount || 1;
    const coverageRate =
      sentenceResults.filter((s) => s.isFactual && s.status === "cited")
        .length / effectiveCount;

    return {
      sentences: sentenceResults,
      coverageRate: Math.round(coverageRate * 1000) / 1000,
      avgScore: Math.round((totalFactualScore / effectiveCount) * 1000) / 1000,
      level: "keyword_fallback",
      weakSentenceIndices: weakIndices,
    };
  }

  // ── KB chunk embedding 缓存 ──

  private async getChunkEmbeddings(chunks: string[]): Promise<number[][]> {
    const results: number[][] = [];
    const toEmbed: { idx: number; text: string }[] = [];

    // 检查缓存
    for (let i = 0; i < chunks.length; i++) {
      const cached = this.chunkEmbeddingCache.get(chunks[i]);
      if (cached) {
        results[i] = cached;
        this.addToCache(chunks[i], cached); // promote on read (true LRU)
      } else {
        toEmbed.push({ idx: i, text: chunks[i] });
      }
    }

    // 批量计算未缓存的
    if (toEmbed.length > 0) {
      try {
        const embeddings = await this.embeddingProvider!.embed(
          toEmbed.map((t) => t.text),
        );
        for (let j = 0; j < toEmbed.length; j++) {
          const { idx, text } = toEmbed[j];
          results[idx] = embeddings[j];
          this.addToCache(text, embeddings[j]);
        }
      } catch (e) {
        logger.warn(e, "CitationVerifier: batch embedding failed");
        // 逐条 fallback
        for (const { idx, text } of toEmbed) {
          try {
            results[idx] = await this.embeddingProvider!.embedSingle(text);
            this.addToCache(text, results[idx]);
          } catch {
            // Expected: embedding may fail for individual text — use zero vector as fallback
            results[idx] = new Array(this.embeddingProvider!.dimension).fill(0);
          }
        }
      }
    }

    return results;
  }

  // ── 空 KB 场景 ──

  private emptyReport(answerText: string): CitationReport {
    const sentences = splitSentences(answerText);
    const sentenceResults: CitationSentence[] = sentences.map((text) => ({
      text,
      isFactual: isFactualSentence(text),
      bestScore: 0,
      bestChunkIndex: -1,
      bestChunkPreview: "",
      status: "uncited" as const,
    }));

    return {
      sentences: sentenceResults,
      coverageRate: 0,
      avgScore: 0,
      level: "keyword_fallback",
      weakSentenceIndices: sentenceResults.map((_, i) => i),
    };
  }

  /** 清除 embedding 缓存（KB 更新后调用） */
  clearCache(): void {
    this.chunkEmbeddingCache.clear();
    this.cacheInsertionOrder = [];
  }

  /** 获取当前缓存大小 */
  get cacheSize(): number {
    return this.chunkEmbeddingCache.size;
  }

  /** LRU 缓存写入（防 OOM：超过上限时淘汰最早 entry） */
  private addToCache(key: string, embedding: number[]): void {
    // 如果 key 已存在，先从淘汰队列移除（后续重新追加到队尾）
    const existingIdx = this.cacheInsertionOrder.indexOf(key);
    if (existingIdx !== -1) {
      this.cacheInsertionOrder.splice(existingIdx, 1);
    }

    // LRU 淘汰：超过上限时移除最早的 entry
    while (this.cacheInsertionOrder.length >= CitationVerifier.MAX_CACHE_SIZE) {
      const oldest = this.cacheInsertionOrder.shift();
      if (oldest !== undefined) {
        this.chunkEmbeddingCache.delete(oldest);
      }
    }

    this.chunkEmbeddingCache.set(key, embedding);
    this.cacheInsertionOrder.push(key);
  }
}

// ── 单例 ──

let _defaultVerifier: CitationVerifier | null = null;

export function getCitationVerifier(): CitationVerifier {
  if (!_defaultVerifier) {
    _defaultVerifier = new CitationVerifier();
  }
  return _defaultVerifier;
}

/** KB 更新时调用，清除缓存使下次校验重新计算 embedding */
export function invalidateCitationCache(): void {
  _defaultVerifier?.clearCache();
}
