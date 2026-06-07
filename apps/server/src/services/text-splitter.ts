export class RecursiveCharacterTextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[];

  constructor(
    chunkSize: number = 500,
    chunkOverlap: number = 50,
    separators?: string[],
  ) {
    if (chunkOverlap >= chunkSize) {
      throw new Error("chunk_overlap must be less than chunk_size");
    }
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
    this.separators = separators || [
      "\n\n",
      "\n",
      ".",
      "！",
      "？",
      "；",
      ". ",
      "! ",
      "? ",
      "; ",
      " ",
      "",
    ];
  }

  splitText(text: string): string[] {
    if (!text) return [];
    return this.splitRecursive(text, this.separators);
  }

  splitDocuments(
    documents: Array<{ id: string; title?: string; content: string }>,
  ): Array<{ docId: string; title: string; chunkIndex: number; content: string }> {
    const chunks: Array<{ docId: string; title: string; chunkIndex: number; content: string }> = [];
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

  private splitRecursive(text: string, separators: string[]): string[] {
    if (separators.length === 0) {
      return this.forceSplit(text);
    }

    const sep = separators[0];
    const remaining = separators.slice(1);

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

      const combined = current + sep + splitText;
      if (combined.length <= this.chunkSize) {
        current = combined;
      } else {
        if (current.length <= this.chunkSize) {
          chunks.push(current);
        } else {
          chunks.push(...this.splitRecursive(current, remaining));
        }
        current = splitText;
      }
    }

    if (current) {
      if (current.length <= this.chunkSize) {
        chunks.push(current);
      } else {
        chunks.push(...this.splitRecursive(current, remaining));
      }
    }

    return this.mergeOverlap(chunks);
  }

  private forceSplit(text: string): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + this.chunkSize, text.length);
      chunks.push(text.slice(start, end));
      start = end - this.chunkOverlap;
      if (start >= end) break;
    }
    return chunks;
  }

  private splitBySeparator(text: string, sep: string): string[] {
    const escaped = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`));
    return parts.filter((part) => part !== sep);
  }

  private mergeOverlap(chunks: string[]): string[] {
    if (this.chunkOverlap <= 0 || chunks.length <= 1) return chunks;

    const merged: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        merged.push(chunks[i]);
        continue;
      }

      const prev = chunks[i - 1];
      const overlapText = prev.length > this.chunkOverlap
        ? prev.slice(-this.chunkOverlap)
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
