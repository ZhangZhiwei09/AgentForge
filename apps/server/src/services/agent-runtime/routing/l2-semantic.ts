// L2 语义意图分类器 —— Embedding + pgvector k-NN
//
// 使用 Embedding + pgvector k-NN 实现基于语义相似度的意图路由。
// 在 quickRouteScan（关键词 L1）未命中后、LLM Router（L3/L4）之前调用。
//
// 核心流程：
//   1. 调用 Embedding Provider 将用户消息向量化
//   2. 在 pgvector intent_samples 表中检索 Top-K 最相似样本
//   3. k-NN 加权投票：按 route 分组累加 cosine similarity
//   4. 返回最高置信度的 route 及匹配详情
//
// 降级策略：Embedding Provider 不可用、pgvector 查询失败或匹配度过低时返回 null，
//           上游 Router 无缝降级到 LLM Router。
//
// 从 semantic-classifier.ts 移入 routing/，保持原有逻辑不变。

import { z } from "zod";
import type { RouteName } from "../types.js";
import { prisma } from "../../../db.js";
import { getDefaultEmbeddingProvider } from "../../embeddings.js";
import type { EmbeddingProvider } from "../../embeddings.js";
import { logger } from "@agentforge/logger";
import { ErrorCode } from "../errors/codes.js";

// ── Zod Schema ──

export const SemanticMatchSchema = z.object({
  sampleId: z.string(),
  route: z.enum(["SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"]),
  text: z.string(),
  similarity: z.number().min(0).max(1),
});

export const SemanticResultSchema = z.object({
  route: z.enum(["SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  matches: z.array(SemanticMatchSchema),
});

export type SemanticMatch = z.infer<typeof SemanticMatchSchema>;
export type SemanticResult = z.infer<typeof SemanticResultSchema>;

// ── 配置 ──

const DEFAULT_TOP_K = 5;
const MIN_SIMILARITY_FOR_VOTE = 0.5; // similarity 低于此值的样本不参与投票

// ── 原始 SQL 返回的行类型（外部数据，需要校验）──

interface RawMatchRow {
  id: string;
  route: string;
  text: string;
  similarity: number;
}

// ═══════════════════════════════════════════════════════════
// SemanticClassifier
// ═══════════════════════════════════════════════════════════

export class SemanticClassifier {
  private provider: EmbeddingProvider | null;
  private topK: number;

  constructor(topK: number = DEFAULT_TOP_K) {
    this.topK = topK;
    this.provider = null;
  }

  /**
   * 延迟获取 Embedding Provider（兼容依赖注入和运行时可替换）。
   */
  private getProvider(): EmbeddingProvider | null {
    if (!this.provider) {
      this.provider = getDefaultEmbeddingProvider();
    }
    return this.provider;
  }

  /**
   * 对用户消息进行语义分类。
   *
   * @param message 用户输入文本
   * @returns SemanticResult（高/中置信度）或 null（需要降级到 LLM Router）
   */
  async classify(message: string): Promise<SemanticResult | null> {
    const provider = this.getProvider();
    if (!provider) {
      logger.info("SemanticClassifier: no embedding provider available, skipping L2");
      return null;
    }

    try {
      // 1. Embedding
      const embedStart = Date.now();
      const queryVec = await provider.embedSingle(message);
      const embedMs = Date.now() - embedStart;

      // 2. pgvector k-NN 检索
      const queryStart = Date.now();
      const matches = await this.searchSimilar(queryVec, this.topK);
      const queryMs = Date.now() - queryStart;

      if (matches.length === 0) {
        logger.info(
          { embeddingMs: embedMs, queryMs },
          "SemanticClassifier: no intent samples matched",
        );
        return null;
      }

      // 3. k-NN 加权投票
      const voteResult = this.weightedVote(matches);

      logger.info(
        {
          route: voteResult.route,
          confidence: Math.round(voteResult.confidence * 100) / 100,
          topSimilarity: Math.round(matches[0].similarity * 100) / 100,
          matchCount: matches.length,
          embeddingMs: embedMs,
          queryMs,
        },
        "SemanticClassifier: L2 classification complete",
      );

      // 异步更新样本使用计数（非阻塞，失败静默忽略）
      this.recordUsage(matches.map((m) => m.sampleId)).catch(() => {});

      return {
        route: voteResult.route,
        confidence: voteResult.confidence,
        reasoning: `L2语义匹配: k-NN投票 (topK=${matches.length}, maxSimilarity=${(matches[0].similarity * 100).toFixed(0)}%)`,
        matches: matches.slice(0, 5), // 只保留 Top-5 供 L3 使用
      };
    } catch (err) {
      logger.warn({ errorCode: ErrorCode.RT_L2_CLASSIFY_FAILED, err }, "SemanticClassifier: classification failed, falling back to LLM Router");
      return null;
    }
  }

  /**
   * 在 pgvector 中检索与查询向量最相似的 Top-K 样本。
   * 使用 cosine distance（<=> 操作符），复用 knowledge.ts 的 SQL 模式。
   */
  private async searchSimilar(
    queryVec: number[],
    k: number,
  ): Promise<SemanticMatch[]> {
    const vecStr = `[${queryVec.join(",")}]`;

    const rows = await prisma.$queryRaw<RawMatchRow[]>`
      SELECT id, route, text, 1 - (embedding <=> ${vecStr}::vector) AS similarity
       FROM intent_samples
       WHERE active = true AND embedding IS NOT NULL
       ORDER BY embedding <=> ${vecStr}::vector
       LIMIT ${k}
    `;

    // 校验外部数据
    const matches: SemanticMatch[] = [];
    for (const row of rows) {
      const sim = Number(row.similarity);
      if (isNaN(sim)) continue;

      const parsed = SemanticMatchSchema.safeParse({
        sampleId: row.id,
        route: row.route,
        text: row.text,
        similarity: Number(sim.toFixed(6)),
      });
      if (parsed.success) {
        matches.push(parsed.data);
      } else {
        logger.warn({ errorCode: ErrorCode.RT_L2_INVALID_MATCH, row, error: parsed.error }, "SemanticClassifier: invalid match row");
      }
    }

    return matches;
  }

  /**
   * k-NN 加权投票：按 route 分组累加 cosine similarity，
   * 最高分组对应的 route 即为分类结果。
   *
   * 投票策略：
   * - 只计入 similarity >= MIN_SIMILARITY_FOR_VOTE 的样本
   * - 按 route 分组累加 similarity 作为该 route 的得分
   * - confidence = top_route_score / total_scores（归一化）
   * - 当 top-1 和 top-2 差距 < 0.15 时，降低置信度（歧义信号）
   */
  private weightedVote(matches: SemanticMatch[]): {
    route: RouteName;
    confidence: number;
  } {
    // 过滤低相似度 + 按 route 累加
    const scores = new Map<RouteName, number>();
    let totalScore = 0;

    for (const m of matches) {
      if (m.similarity < MIN_SIMILARITY_FOR_VOTE) continue;

      scores.set(m.route, (scores.get(m.route) ?? 0) + m.similarity);
      totalScore += m.similarity;
    }

    // 无有效匹配 → 默认 TASK
    if (scores.size === 0) {
      return { route: "TASK", confidence: 0 };
    }

    // 按得分降序排列
    const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const bestRoute = sorted[0][0];
    const bestScore = sorted[0][1];
    const secondScore = sorted.length > 1 ? sorted[1][1] : 0;

    // 归一化置信度
    let confidence = totalScore > 0 ? bestScore / totalScore : 0;

    // 歧义惩罚：top-1 和 top-2 差距过小 → 降低置信度
    if (sorted.length > 1 && secondScore > 0) {
      const gap = (bestScore - secondScore) / totalScore;
      if (gap < 0.15) {
        confidence *= 0.8; // 20% 惩罚
      }
    }

    return {
      route: bestRoute,
      confidence: Math.min(confidence, 1.0),
    };
  }

  /** 更新样本使用计数（非阻塞，失败静默忽略） */
  async recordUsage(matchIds: string[]): Promise<void> {
    if (matchIds.length === 0) return;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE intent_samples SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = ANY($1::text[])`,
        matchIds,
      );
    } catch {
      // 非关键路径，静默忽略
    }
  }

  /** 检查 L2 是否可用（Embedding Provider 已配置且 pgvector 可达） */
  async isAvailable(): Promise<boolean> {
    try {
      const provider = this.getProvider();
      if (!provider) return false;

      // 快速检查 pgvector 是否可达（有样本即可）
      const count = await prisma.intentSample.count({ where: { active: true } });
      return count > 0;
    } catch {
      return false;
    }
  }
}

// ── 单例 ──

let _defaultClassifier: SemanticClassifier | null = null;

export function getSemanticClassifier(): SemanticClassifier {
  if (!_defaultClassifier) {
    _defaultClassifier = new SemanticClassifier();
  }
  return _defaultClassifier;
}
