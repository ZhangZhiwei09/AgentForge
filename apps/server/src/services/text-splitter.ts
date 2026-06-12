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
