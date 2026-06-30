// NormalizerService — lightweight orchestration of text cleaning + metrics.
// Does NOT make quality decisions (those belong in the Ingestion Worker).

import { cleanText, cleanTextWithRules, computeMetrics, type TextMetrics, type PreprocessingRules } from "./cleaner.js";

export interface NormalizedDocument {
  text: string;
  metrics: TextMetrics;
}

export class NormalizerService {
  /**
   * Clean raw extracted text and compute observability metrics.
   * The returned `metrics` are for OBSERVABILITY ONLY.
   * Quality gate decisions (scan / low / good) live exclusively in the Ingestion Worker.
   */
  normalize(rawText: string, pageCount?: number): NormalizedDocument {
    const text = cleanText(rawText);
    const metrics = computeMetrics(text, pageCount);
    return { text, metrics };
  }

  /**
   * V3.5: 带规则的清洗（在基础 normalize 之上应用 KB 级预处理规则）。
   */
  normalizeWithRules(rawText: string, rules?: PreprocessingRules, pageCount?: number): NormalizedDocument {
    const text = cleanTextWithRules(rawText, rules);
    const metrics = computeMetrics(text, pageCount);
    return { text, metrics };
  }
}
