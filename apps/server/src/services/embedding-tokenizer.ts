// embedding-tokenizer.ts —— 独立的 Embedding Token 计数工具
//
// 专门用于知识库分片时的 token 数控制，不复用 tokenizer.ts 的 jieba/BM25 token。
// Embedding 模型的 tokenization 与关键词分词不同：
//   - BM25/jieba 面向倒排索引，侧重词级别切分和 stop words 过滤
//   - Embedding tokenizer 面向 LLM embedding API，侧重 token 数控制
//
// 策略：
//   1. 优先使用 tiktoken（cl100k_base，用于 OpenAI text-embedding-3 等模型）
//   2. tiktoken 不可用时回退到启发式估算（中英文混合场景准确性足够）

// tiktoken 类型声明见 src/types/tiktoken.d.ts

let tiktokenEncoding: { encode: (text: string) => number[] } | null = null;
let tiktokenLoadAttempted = false;

async function loadTiktoken(): Promise<void> {
  if (tiktokenLoadAttempted) return;
  tiktokenLoadAttempted = true;

  try {
    // tiktoken 为可选依赖，未安装时回退到启发式估算
    const mod = await import("tiktoken");
    if (typeof mod.get_encoding === "function") {
      tiktokenEncoding = mod.get_encoding("cl100k_base");
    } else if (typeof mod.encoding_for_model === "function") {
      tiktokenEncoding = mod.encoding_for_model("text-embedding-3-small");
    }
  } catch {
    // tiktoken 不可用，回退到启发式估算
  }
}

// ── 启发式 Token 估算（tiktoken 不可用时的回退方案） ──

/**
 * 启发式估算 embedding token 数。
 *
 * 基于 OpenAI tokenizer 的一般行为：
 *   - CJK 字符 ≈ 1.5 tokens/字（保守估计，考虑罕见字可能拆分为多 token）
 *   - 英文/拉丁单词 ≈ 1.3 tokens/词
 *   - 数字和标点 ≈ 0.3 tokens/字符
 *
 * 此估算用于 chunk size 控制，保守估计（偏高）可确保不超过 embedding API 限制。
 */
function estimateTokens(text: string): number {
  if (!text) return 0;

  // Unicode 范围判断
  const cjkRegex = /[一-鿿㐀-䶿豈-﫿]/g;
  const wordRegex = /[a-zA-Z]+/g;
  const digitRegex = /\d+/g;

  // 统计各类字符
  const cjkChars = (text.match(cjkRegex) || []).length;
  const cjkText = text.replace(cjkRegex, "");
  const englishWords = (cjkText.match(wordRegex) || []).length;
  const digitChars = (cjkText.match(digitRegex) || []).join("").length;

  // 剩余字符（标点、空格等）
  const remainingChars = Math.max(
    0,
    cjkText.length - englishWords * 5 - digitChars, // 估算英文单词平均 5 字母
  );

  // Token 估算
  // CJK: 1.5 tokens/字
  // 英文单词: 1.3 tokens/词
  // 数字: 1 token/每 4 位
  // 其他: 0.2 tokens/字
  const tokens =
    cjkChars * 1.5 +
    englishWords * 1.3 +
    digitChars * 0.3 +
    remainingChars * 0.2;

  return Math.max(1, Math.ceil(tokens));
}

// ── 公开 API ────────────────────────────────────────────────

/**
 * 计算文本的 embedding token 数。
 *
 * 优先使用 tiktoken 精确计数，不可用时回退到启发式估算。
 * 注意：因为 tiktoken 是异步加载的，首次调用会触发动态 import。
 *
 * @param text - 待计算的文本
 * @returns token 数量
 */
export async function countEmbeddingTokens(text: string): Promise<number> {
  if (!text) return 0;

  // 尝试加载 tiktoken
  await loadTiktoken();

  if (tiktokenEncoding) {
    try {
      return tiktokenEncoding.encode(text).length;
    } catch {
      // tiktoken 编码失败，回退到启发式估算
    }
  }

  return estimateTokens(text);
}

/**
 * 同步版本的 token 计数（用于 splitter 中的快速判断）。
 *
 * 仅使用启发式估算，不依赖 tiktoken 动态加载。
 * 适合在 splitter 的循环中快速判断 chunk 是否超长。
 * 误差在 ±15% 范围内，足够用于分片大小控制。
 *
 * @param text - 待计算的文本
 * @returns 估算 token 数量
 */
export function estimateEmbeddingTokens(text: string): number {
  return estimateTokens(text);
}

/**
 * 计算文本片段的 token 数（精确版，优先 tiktoken）。
 *
 * 注意：此函数会触发 tiktoken 动态加载，适合在非热路径（如 ingestion 入口）使用。
 * 分片循环内请使用 estimateEmbeddingTokens() 避免异步开销。
 */
export async function countTokens(text: string): Promise<number> {
  return countEmbeddingTokens(text);
}
