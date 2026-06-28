// ── Embedding Token 估算（局部使用，避免循环导入） ──

/**
 * 启发式估算 embedding token 数（同步版本，用于分片循环内快速判断）。
 * 保守估计（偏高），确保不超出 embedding API 限制。
 */
function estimateTokensLocal(text: string): number {
  if (!text) return 0;
  const cjkChars = (text.match(/[一-鿿㐀-䶿豈-﫿]/g) || []).length;
  const cjkFree = text.replace(/[一-鿿㐀-䶿豈-﫿]/g, "");
  const englishWords = (cjkFree.match(/[a-zA-Z]+/g) || []).length;
  const digitChars = (cjkFree.match(/\d+/g) || []).join("").length;
  const remaining = Math.max(0, cjkFree.length - englishWords * 5 - digitChars);
  const tokens =
    cjkChars * 1.5 + englishWords * 1.3 + digitChars * 0.3 + remaining * 0.2;
  return Math.max(1, Math.ceil(tokens));
}

// ── RecursiveCharacterTextSplitter（字符数驱动，向后兼容） ──

// 递归字符文本切分器 —— 将长文档智能切分为固定大小的片段
// 参考 LangChain 的 RecursiveCharacterTextSplitter 设计
// 切分策略：按分隔符优先级递归降级，尽量在语义边界（段落、句子）断开
export class RecursiveCharacterTextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[]; // 分隔符优先级：优先在高级边界切分

  constructor(
    chunkSize: number = 500, // 每个 chunk 最大字符数
    chunkOverlap: number = 50, // 相邻 chunk 重叠字符数（保持语义连贯）
    separators?: string[],
  ) {
    if (chunkOverlap >= chunkSize) {
      throw new Error("chunk_overlap must be less than chunk_size");
    }
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
    // 分隔符优先级：段落 → 行 → 句子 → 词 → 字符
    this.separators = separators || [
      "\n\n", // 段落分隔
      "\n", // 行分隔
      ".",
      "！",
      "？",
      "；", // 中文标点
      ". ",
      "! ",
      "? ",
      "; ", // 英文标点（带空格）
      " ", // 词分隔
      "", // 字符级切分（兜底）
    ];
  }

  // 切分单篇文本
  splitText(text: string): string[] {
    if (!text) return [];
    return this.splitRecursive(text, this.separators);
  }

  // 批量切分文档（返回带 docId 和 chunkIndex 的结构化结果）
  splitDocuments(
    documents: Array<{ id: string; title?: string; content: string }>,
  ): Array<{
    docId: string;
    title: string;
    chunkIndex: number;
    content: string;
  }> {
    const chunks: Array<{
      docId: string;
      title: string;
      chunkIndex: number;
      content: string;
    }> = [];
    for (const doc of documents) {
      const texts = this.splitText(doc.content);
      for (let i = 0; i < texts.length; i++) {
        chunks.push({
          docId: doc.id,
          title: doc.title || "",
          chunkIndex: i,
          content: texts[i],
        });
      }
    }
    return chunks;
  }

  // 递归切分核心：按当前分隔符切分，超长片段用下一级分隔符继续切
  private splitRecursive(text: string, separators: string[]): string[] {
    // 递归终点：没有更多分隔符可用，强制按字符数切分
    if (separators.length === 0) {
      return this.forceSplit(text);
    }

    const sep = separators[0];
    const remaining = separators.slice(1);

    // "" 是最后的兜底分隔符，直接强制切分
    if (sep === "") {
      return this.forceSplit(text);
    }

    const splits = this.splitBySeparator(text, sep);

    const chunks: string[] = [];
    let current = "";
    for (const splitText of splits) {
      if (!splitText) continue;
      if (!current) {
        current = splitText;
        continue;
      }

      // 尝试合并当前片段：没超长就继续拼，超长了就输出 current，换下一段
      const combined = current + sep + splitText;
      if (combined.length <= this.chunkSize) {
        current = combined;
      } else {
        // current 本身不超长直接输出，否则用下一级分隔符递归切分
        if (current.length <= this.chunkSize) {
          chunks.push(current);
        } else {
          chunks.push(...this.splitRecursive(current, remaining));
        }
        current = splitText;
      }
    }

    // 处理最后一个片段
    if (current) {
      if (current.length <= this.chunkSize) {
        chunks.push(current);
      } else {
        chunks.push(...this.splitRecursive(current, remaining));
      }
    }

    return this.mergeOverlap(chunks);
  }

  // 强制按字符数切分（最后的兜底策略）
  private forceSplit(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + this.chunkSize, text.length);
      chunks.push(text.slice(start, end));
      start = end - this.chunkOverlap; // 减去 overlap 使相邻 chunk 有重叠
      if (start >= end) break;
    }
    return chunks;
  }

  // 按分隔符切分文本（保留分隔符作为独立片段）
  private splitBySeparator(text: string, sep: string): string[] {
    const escaped = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`));
    return parts.filter((part) => part !== sep);
  }

  // 相邻 chunk 重叠合并：将前一个 chunk 的尾部拼到后一个 chunk 的头部
  private mergeOverlap(chunks: string[]): string[] {
    if (this.chunkOverlap <= 0 || chunks.length <= 1) return chunks;

    const merged: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        merged.push(chunks[i]);
        continue;
      }

      const prev = chunks[i - 1];
      const overlapText =
        prev.length > this.chunkOverlap
          ? prev.slice(-this.chunkOverlap) // 取前一个 chunk 的尾部作为重叠
          : prev;

      if (overlapText.length + chunks[i].length <= this.chunkSize) {
        merged.push(overlapText + chunks[i]);
      } else {
        merged.push(chunks[i]);
      }
    }
    return merged;
  }
}

// ════════════════════════════════════════════════════════════════
// RecursiveTokenTextSplitter —— Token 感知的递归文本切分器
//
// 与 RecursiveCharacterTextSplitter 的区别：
//   1. 按 embedding token 数判断 chunk 大小，而非字符数
//   2. overlap 从上一 chunk 末尾取完整语义单元（句子/列表项/段落），避免从半句话截断
//   3. token 估算使用局部快速估算函数，避免异步开销
//
// 默认策略（来自环境变量或 KB 配置）：
//   - chunkSizeTokens = 800
//   - chunkOverlapTokens = 120
// ════════════════════════════════════════════════════════════════

export class RecursiveTokenTextSplitter {
  private chunkSizeTokens: number;
  private chunkOverlapTokens: number;
  // 分隔符优先级：段落 → 行 → 句子结束 → 列表项 → 分句标点 → 空格 → 字符
  private separators: string[];

  constructor(
    chunkSizeTokens: number = 800,
    chunkOverlapTokens: number = 120,
    separators?: string[],
  ) {
    if (chunkOverlapTokens >= chunkSizeTokens) {
      throw new Error(
        `chunk_overlap_tokens (${chunkOverlapTokens}) must be less than chunk_size_tokens (${chunkSizeTokens})`,
      );
    }
    if (chunkSizeTokens < 50) {
      throw new Error("chunk_size_tokens must be at least 50");
    }
    this.chunkSizeTokens = chunkSizeTokens;
    this.chunkOverlapTokens = chunkOverlapTokens;
    this.separators = separators || [
      "\n\n",   // 段落分隔（最高优先级）
      "\n",     // 行分隔
      "。", "！", "？", "；",   // 中文句末标点
      ". ", "! ", "? ",         // 英文句末标点（带空格，避免缩写误切）
      "；", "；",                 // 中文分号
      "，", "、",                 // 中文逗号/顿号
      ", ",                      // 英文逗号（带空格）
      " ",                       // 词分隔
      "",                        // 字符级切分（最终兜底）
    ];
  }

  /** Token 估算（同步，用于分片循环） */
  private tokenCount(text: string): number {
    return estimateTokensLocal(text);
  }

  /** 切分单篇文本 */
  splitText(text: string): string[] {
    if (!text) return [];
    return this.splitRecursive(text, this.separators);
  }

  /** 批量切分文档 */
  splitDocuments(
    documents: Array<{ id: string; title?: string; content: string }>,
  ): Array<{
    docId: string;
    title: string;
    chunkIndex: number;
    content: string;
  }> {
    const chunks: Array<{
      docId: string;
      title: string;
      chunkIndex: number;
      content: string;
    }> = [];
    for (const doc of documents) {
      const texts = this.splitText(doc.content);
      for (let i = 0; i < texts.length; i++) {
        chunks.push({
          docId: doc.id,
          title: doc.title || "",
          chunkIndex: i,
          content: texts[i],
        });
      }
    }
    return chunks;
  }

  // ── 递归切分核心 ──

  private splitRecursive(text: string, separators: string[]): string[] {
    // 终点：无分隔符 → 强制按 token 切分
    if (separators.length === 0 || separators[0] === "") {
      return this.forceSplitByTokens(text);
    }

    const sep = separators[0];
    const remaining = separators.slice(1);

    const splits = this.splitBySeparator(text, sep);
    const chunks: string[] = [];
    let current = "";

    for (const splitText of splits) {
      if (!splitText) continue;
      if (!current) {
        current = splitText;
        continue;
      }

      const combined = current + sep + splitText;
      if (this.tokenCount(combined) <= this.chunkSizeTokens) {
        // 还没超长，继续合并
        current = combined;
      } else {
        // current 本身不超长 → 输出；否则递归降级切分
        if (this.tokenCount(current) <= this.chunkSizeTokens) {
          chunks.push(current);
        } else {
          chunks.push(...this.splitRecursive(current, remaining));
        }
        current = splitText;
      }
    }

    // 处理最后一个片段
    if (current) {
      if (this.tokenCount(current) <= this.chunkSizeTokens) {
        chunks.push(current);
      } else {
        chunks.push(...this.splitRecursive(current, remaining));
      }
    }

    return this.mergeTokenOverlap(chunks);
  }

  // ── 按分隔符切分（保留分隔符） ──

  private splitBySeparator(text: string, sep: string): string[] {
    const escaped = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`));
    return parts.filter((part) => part !== sep);
  }

  // ── Token 感知的强制切分（最终兜底） ──

  private forceSplitByTokens(text: string): string[] {
    const chunks: string[] = [];
    const maxLen = this.chunkSizeTokens;

    // 估算每个字符的平均 token 数
    const totalTokens = this.tokenCount(text);
    const avgTokensPerChar = totalTokens / Math.max(1, text.length);

    // 安全粒度：每次取 chunkSizeTokens / avgTokensPerChar 个字符
    const safeCharsPerChunk = Math.max(1, Math.floor(maxLen / avgTokensPerChar));

    let start = 0;
    let iterations = 0;
    const maxIterations = text.length * 2; // 防死循环

    while (start < text.length && iterations < maxIterations) {
      iterations++;
      let end = Math.min(start + safeCharsPerChunk, text.length);

      // 微调：如果 tokenCount 超标，回退字符
      let candidate = text.slice(start, end);
      while (this.tokenCount(candidate) > maxLen && end > start + 1) {
        end--;
        candidate = text.slice(start, end);
      }

      // 如果单个字符就超长（极端情况），至少保留它
      if (end <= start) {
        end = start + 1;
      }

      const chunkText = text.slice(start, end);
      chunks.push(chunkText);

      // overlap 回退：从 current chunk 末尾找语义边界
      // 确保 overlap 不超过 chunk 本身长度，防止越界和微步进
      const overlapStart = Math.min(
        this.findOverlapBoundary(chunkText),
        chunkText.length - 1, // 至少前进 1 个字符，防止死循环
      );

      start = Math.max(start + 1, end - overlapStart); // 确保单调前进
      if (start >= text.length) break; // 已处理完
    }

    return chunks;
  }

  // ── Token 感知的 Overlap 合并（语义边界保留） ──

  /**
   * 相邻 chunk 重叠合并：
   * 从上一个 chunk 的末尾取若干完整语义单元（句子/列表项/段落），
   * 而非简单截取固定字符数。只有单个语义单元超过 overlap token 上限时才做截断。
   */
  private mergeTokenOverlap(chunks: string[]): string[] {
    if (this.chunkOverlapTokens <= 0 || chunks.length <= 1) return chunks;

    const merged: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        merged.push(chunks[i]);
        continue;
      }

      const prev = chunks[i - 1];
      const overlapText = this.extractSemanticOverlap(prev);

      if (!overlapText) {
        merged.push(chunks[i]);
        continue;
      }

      const combinedTokens = this.tokenCount(overlapText + chunks[i]);
      if (combinedTokens <= this.chunkSizeTokens) {
        merged.push(overlapText + chunks[i]);
      } else {
        // overlap + current 超出限制，但仍保留 overlap 以维护连贯性
        // 截断 overlap 到不超过 chunkOverlapTokens
        const truncated = this.truncateToTokenLimit(
          overlapText,
          this.chunkOverlapTokens,
        );
        merged.push(truncated + chunks[i]);
      }
    }
    return merged;
  }

  /**
   * 从 chunk 末尾提取语义完整的 overlap 文本。
   *
   * 策略（优先级从高到低）：
   *   1. 最后一句完整的话（以 。！？. ! ? 结尾）
   *   2. 最后一个完整行
   *   3. 最后 N 个 token（兜底截断）
   */
  private extractSemanticOverlap(chunk: string): string {
    const targetTokens = this.chunkOverlapTokens;
    if (!chunk) return "";

    // 1. 尝试取最后一句完整的话
    const sentenceSep = /[。！？.!?]/g;
    const sentences: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = sentenceSep.exec(chunk)) !== null) {
      sentences.push(match.index + match[0].length);
    }

    if (sentences.length > 0) {
      // 从后往前找，累计 token 数不超过目标
      let selected = "";
      for (let i = sentences.length - 1; i >= 0; i--) {
        const start = i === 0 ? 0 : sentences[i - 1];
        const sentence = chunk.slice(start, sentences[i]);
        const candidate = sentence + selected;
        if (this.tokenCount(candidate) <= targetTokens) {
          selected = candidate;
        } else {
          break;
        }
      }
      if (selected.trim()) return selected;
    }

    // 2. 尝试取最后一个完整行
    const lines = chunk.split("\n").filter((l) => l.trim());
    if (lines.length > 0) {
      let lineSelected = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const candidate = lines[i] + (lineSelected ? "\n" : "") + lineSelected;
        if (this.tokenCount(candidate) <= targetTokens) {
          lineSelected = candidate;
        } else {
          break;
        }
      }
      if (lineSelected.trim()) return lineSelected;
    }

    // 3. 兜底：按 token 截断末尾
    return this.truncateToTokenLimit(chunk, targetTokens);
  }

  /**
   * 强制截断文本到指定 token 数以内（从文本末尾取）。
   * 用于兜底场景：单个语义单元超过 overlap 上限时。
   */
  private truncateToTokenLimit(text: string, maxTokens: number): string {
    if (!text) return "";
    if (this.tokenCount(text) <= maxTokens) return text;

    // 从后往前逐句截取，确保不超 maxTokens
    const chars = [...text]; // 正确处理 Unicode（含 CJK/emoji）
    let result = "";
    for (let i = chars.length - 1; i >= 0; i--) {
      const candidate = chars.slice(i).join("");
      if (this.tokenCount(candidate) > maxTokens) break;
      result = candidate;
    }
    return result;
  }

  /**
   * 在文本末尾寻找 overlap 起始边界。
   * 返回从文本开头到边界的字符数（即上一 chunk 末尾应保留的字符数）。
   * 用于 forceSplitByTokens 中计算下一段的 start 位置。
   */
  private findOverlapBoundary(chunkText: string): number {
    if (!chunkText || this.chunkOverlapTokens <= 0) return 0;

    // 优先找最后一句完整话的边界
    const sentenceBoundaries = [
      ...chunkText.matchAll(/[。！？.!?]/g),
    ].map((m) => m.index! + 1);

    if (sentenceBoundaries.length > 0) {
      let totalFromEnd = 0;
      for (let i = sentenceBoundaries.length - 1; i >= 0; i--) {
        const start = i === 0 ? 0 : sentenceBoundaries[i - 1];
        const segment = chunkText.slice(start, sentenceBoundaries[i]);
        const segTokens = this.tokenCount(segment);
        if (totalFromEnd + segTokens <= this.chunkOverlapTokens) {
          totalFromEnd += segTokens;
        } else {
          break;
        }
      }
      // 返回从该边界到末尾的字符数
      if (totalFromEnd > 0) {
        const overlapText = this.extractSemanticOverlap(chunkText);
        return overlapText.length;
      }
    }

    // 兜底：按 token 估算的字符数
    const avgToksPerChar =
      this.tokenCount(chunkText) / Math.max(1, chunkText.length);
    return Math.floor(this.chunkOverlapTokens / avgToksPerChar);
  }
}
