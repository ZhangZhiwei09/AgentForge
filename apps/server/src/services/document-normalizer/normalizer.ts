// NormalizerService — lightweight orchestration of text cleaning + metrics.
// Does NOT make quality decisions (those belong in the Ingestion Worker).

import { cleanText, computeMetrics, type TextMetrics } from "./cleaner.js";

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
}
