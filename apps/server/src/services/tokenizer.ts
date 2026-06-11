// tokenizer.ts —— jieba 中文分词封装
// 基于 @node-rs/jieba (Rust 原生绑定)，提供中英文混合分词 + stop words 过滤
import { Jieba } from "@node-rs/jieba";

let jieba: Jieba | null = null;

function getJieba(): Jieba {
  if (!jieba) {
    jieba = new Jieba();
  }
  return jieba;
}

// ── Stop Words ──────────────────────────────
// 中英文常见停用词，这些词对 BM25 关键词匹配无贡献
const STOP_WORDS = new Set([
  // 中文
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那", "些",
  "什么", "怎么", "哪", "为什么", "因为", "所以", "但", "但是", "虽然",
  "如果", "可以", "还是", "这个", "那个", "这里", "那里", "这种", "那种",
  "等", "之", "与", "及", "或", "将", "把", "被", "让", "对", "从",
  "向", "以", "为", "其", "而", "且", "并", "所", "者", "又", "再",
  "才", "刚", "已", "曾", "能", "会", "可", "可能", "应该", "需要",
  "进行", "使用", "通过", "根据", "按照", "关于", "对于", "以及",
  "吗", "呢", "吧", "啊", "哦", "嗯", "哈",
  "哪些", "哪里", "什么", "怎么", "为什么", "我", "你", "您",
  "这", "那", "这个", "那个", "这种", "那种",
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "under", "again",
  "then", "than", "so", "if", "and", "but", "or", "not", "no", "nor",
  "it", "its", "they", "them", "their", "he", "she", "his", "her",
  "this", "that", "these", "those", "which", "who", "whom", "what",
  "when", "where", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "only", "own", "same",
]);

// ── 公开 API ────────────────────────────────

export function tokenize(text: string): string[] {
  if (!text) return [];

  const lower = text.toLowerCase();

  // jieba 分词（HMM 开启，对未登录词更友好）
  const rawTokens = getJieba().cut(lower, true);

  return rawTokens.filter((t) => {
    const trimmed = t.trim();
    if (!trimmed || trimmed.length === 0) return false;
    if (STOP_WORDS.has(trimmed)) return false;
    // 保留含字母/数字/CJK 字符的 token，过滤纯标点/空白
    if (!/[\w一-鿿]/.test(trimmed)) return false;
    // 过滤单英文字母（几乎都是噪音）
    if (/^[a-z]$/.test(trimmed)) return false;
    return true;
  });
}

/** 返回有效 token 数量（用于文档长度归一化） */
export function getTokenCount(text: string): number {
  return tokenize(text).length;
}
