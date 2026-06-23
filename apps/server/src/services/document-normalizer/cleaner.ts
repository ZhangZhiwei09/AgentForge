// Pure text cleaning functions.
// NO quality decisions, NO structure recovery — just format normalization.

/**
 * Normalize whitespace and newlines in extracted text.
 * - Unified line endings (CRLF → LF)
 * - Collapse runs of 3+ blank lines into 2
 * - Trim leading/trailing whitespace
 *
 * This is intentionally minimal — we do NOT attempt header/footer removal,
 * section recovery, or any "understanding" of the document structure.
 */
export function cleanText(text: string): string {
  return text
    // Normalize Windows line endings
    .replace(/\r\n/g, "\n")
    // Lone CR → LF
    .replace(/\r/g, "\n")
    // Collapse 3+ consecutive newlines into 2 (preserve paragraph breaks)
    .replace(/\n{3,}/g, "\n\n")
    // Trim surrounding whitespace
    .trim();
}

/**
 * Compute lightweight observability metrics for extracted text.
 * These are PURE DATA — no decision logic lives here.
 * Quality gate decisions are made exclusively in the Ingestion Worker.
 */
export interface TextMetrics {
  charCount: number;
  textDensity: number;
  lineCount: number;
}

export function computeMetrics(
  text: string,
  pageCount?: number,
): TextMetrics {
  const lines = text.split("\n");
  const charCount = text.length;
  const lineCount = lines.length;

  // textDensity: rough measure of characters per "page" normalized to 2000
  // (a typical text-heavy page has ~2000-3000 chars)
  // pageCount=undefined (flat text): default to 1.0
  const effectivePages = Math.max(pageCount ?? 1, 1);
  const textDensity = Math.min(charCount / effectivePages / 2000, 1);

  return { charCount, textDensity, lineCount };
}
