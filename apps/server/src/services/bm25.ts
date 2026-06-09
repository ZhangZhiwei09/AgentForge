// BM25 稀疏向量编码器 —— 用于知识库混合搜索的关键词匹配部分
// BM25 是经典的信息检索算法，基于词频（TF）和逆文档频率（IDF）
// 实现参考：Okapi BM25，k1=1.2, b=0.75
//
// 编码流程：
//   1. fit(corpus) —— 在语料库上训练，统计每个词的 DF/IDF + 文档长度
//   2. encodeDocuments(docs) —— 将文档转为稀疏向量 {词索引: BM25权重}
//   3. encodeQueries(queries) —— 将查询转为稀疏向量（只保留 IDF>0 的 term）
//
import { logger } from "@agentforge/logger";
// 稀疏向量格式：Record<string, number> —— key 是词索引（0~vocabSize-1），value 是权重

// ── 分词工具函数 ──────────────────────────────

// 简单的中英文分词：英文按空格/标点拆，中文按字拆（也可按 2-gram）
function tokenize(text: string): string[] {
  if (!text) return [];

  // 统一转为小写
  const lower = text.toLowerCase();

  // 分离中文字符和英文/数字
  const tokens: string[] = [];
  // 英文单词 + 中文单字 + 数字
  const pattern = /[a-z0-9]+|[一-鿿]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(lower)) !== null) {
    const token = match[0];
    // 中文字符：生成 1-gram 和 2-gram（提升匹配度）
    if (/^[一-鿿]$/.test(token)) {
      tokens.push(token); // 单字
    } else {
      // 英文/数字：直接作为一个 token
      if (token.length >= 2) {
        tokens.push(token);
      }
    }
  }

  // 额外生成中文 2-gram（bigram）
  const chineseOnly: string[] = [];
  for (const ch of lower) {
    if (/[一-鿿]/.test(ch)) {
      chineseOnly.push(ch);
    }
  }
  for (let i = 0; i < chineseOnly.length - 1; i++) {
    tokens.push(chineseOnly[i] + chineseOnly[i + 1]);
  }

  return tokens;
}

// ── BM25 参数 ─────────────────────────────────

const BM25_K1 = 1.2;  // TF 饱和参数
const BM25_B = 0.75;   // 文档长度归一化参数

// ── BM25 稀疏编码器 ──────────────────────────

export class BM25SparseEncoder {
  // 词汇表：词 → 索引（0-based）
  private vocab: Map<string, number> = new Map();
  // 逆文档频率：词索引 → IDF 值
  private idf: Map<number, number> = new Map();
  // 平均文档长度（词数）
  private avgDocLen = 0;
  // 语料库大小
  private corpusSize = 0;
  // 是否已训练
  isFitted = false;

  // 在语料库上训练 BM25：统计每个词的文档频率（DF）→ 计算 IDF
  // 幂等操作：多次调用会覆盖之前的统计
  fit(corpus: string[]): void {
    if (!corpus.length) return;

    this.vocab.clear();
    this.idf.clear();
    this.corpusSize = corpus.length;

    // 第一遍：统计每个词的文档频率（DF）和文档长度
    let totalLen = 0;
    const docFreq = new Map<string, number>(); // 词 → 出现在多少个文档中

    for (const doc of corpus) {
      const tokens = tokenize(doc);
      totalLen += tokens.length;

      // 每个文档中每个词只计一次 DF
      const uniqueTokens = new Set(tokens);
      for (const token of uniqueTokens) {
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
      }
    }

    this.avgDocLen = totalLen / corpus.length;

    // 第二遍：建立词汇表 + 计算 IDF
    // IDF = log((N - df + 0.5) / (df + 0.5) + 1)
    let vocabIndex = 0;
    const N = corpus.length;
    for (const [term, df] of docFreq.entries()) {
      this.vocab.set(term, vocabIndex);
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      this.idf.set(vocabIndex, idf);
      vocabIndex++;
    }

    this.isFitted = true;
    logger.info({ docs: corpus.length, vocab: this.vocab.size, avgDocLen: Math.round(this.avgDocLen) }, "BM25 fitted");
  }

  // 将文档编码为稀疏向量 —— 用于存入 Milvus
  // 返回 {词索引字符串: BM25权重} 字典
  encodeDocuments(docs: string[]): Array<Record<string, number>> {
    if (!this.isFitted) return docs.map(() => ({}));

    return docs.map((doc) => this.encodeDocVector(doc));
  }

  // 将查询编码为稀疏向量 —— 用于搜索
  // 只包含词汇表中存在的词
  encodeQueries(queries: string[]): Array<Record<string, number>> {
    if (!this.isFitted) return queries.map(() => ({}));

    return queries.map((query) => {
      const tokens = tokenize(query);
      const vec: Record<string, number> = {};

      // 统计查询中每个词的词频
      const tfCount = new Map<string, number>();
      for (const t of tokens) {
        tfCount.set(t, (tfCount.get(t) ?? 0) + 1);
      }

      for (const [term, tf] of tfCount.entries()) {
        const idx = this.vocab.get(term);
        if (idx === undefined) continue; // 词汇表外，跳过

        const termIdf = this.idf.get(idx) ?? 0;
        // 查询中不归一文长，直接使用 IDF * TF 作为权重
        // k1 在查询侧不应用（标准 BM25 查询权重）
        const weight = termIdf * tf;
        if (weight > 0) {
          vec[String(idx)] = weight;
        }
      }

      return vec;
    });
  }

  // 内部：编码单篇文档的 BM25 向量
  private encodeDocVector(doc: string): Record<string, number> {
    const tokens = tokenize(doc);
    const docLen = tokens.length;

    // 统计文档内每个词的词频
    const tfCount = new Map<string, number>();
    for (const t of tokens) {
      tfCount.set(t, (tfCount.get(t) ?? 0) + 1);
    }

    const vec: Record<string, number> = {};
    for (const [term, tf] of tfCount.entries()) {
      const idx = this.vocab.get(term);
      if (idx === undefined) continue;

      const termIdf = this.idf.get(idx) ?? 0;

      // BM25 权重公式：
      // weight = IDF * (TF * (k1 + 1)) / (TF + k1 * (1 - b + b * docLen / avgDocLen))
      const numerator = tf * (BM25_K1 + 1);
      const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / this.avgDocLen));
      const weight = termIdf * (numerator / denominator);

      if (weight > 0) {
        vec[String(idx)] = weight;
      }
    }

    return vec;
  }

  // 便捷工厂：从语料库直接创建已训练的编码器
  static fitOnCorpus(corpus: string[]): BM25SparseEncoder {
    const encoder = new BM25SparseEncoder();
    encoder.fit(corpus);
    return encoder;
  }
}
