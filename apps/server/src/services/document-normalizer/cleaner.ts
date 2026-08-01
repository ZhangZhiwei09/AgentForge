// Pure text cleaning functions.
// NO quality decisions, NO structure recovery — just format normalization.

/**
 * Preprocessing rules config（参考 Dify PRE_PROCESSING_RULES）。
 * 控制哪些清理步骤在文档标准化阶段执行。
 */
export interface PreprocessingRules {
  /** 去除多余空格（多个空格 → 单个空格，默认 true） */
  removeExtraSpaces?: boolean;
  /** 去除 URL 和邮箱地址（默认 false） */
  removeUrlsEmails?: boolean;
}

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
 * V3.5: 带规则的文本清理。
 * 在基础 cleanText 之上，应用可配置的预处理规则。
 */
export function cleanTextWithRules(text: string, rules?: PreprocessingRules): string {
  let result = cleanText(text);
  if (!rules) return result;

  // 去除 URL 和邮箱（Dify 默认关闭，手动开启后会删除敏感链接信息）
  if (rules.removeUrlsEmails) {
    result = removeUrlsAndEmails(result);
  }

  // 去除多余空格（Dify 默认开启：多个空格/制表符 → 单个空格，但保留换行）
  if (rules.removeExtraSpaces !== false) {
    result = collapseExtraSpaces(result);
  }

  return result;
}

/**
 * 去除 URL（http/https/ftp）和邮箱地址。
 * 替换为占位符，避免丢失所有语义信息（如 "请联系 support@example.com" → "请联系 "）。
 */
function removeUrlsAndEmails(text: string): string {
  // 邮箱：user@domain.tld
  let result = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "");
  // URL：http/https/ftp
  result = result.replace(/https?:\/\/[^\s)]+/g, "");
  result = result.replace(/ftp:\/\/[^\s)]+/g, "");
  // 清理可能残留的多余空格
  return result.replace(/ {2,}/g, " ").trim();
}

/**
 * 折叠多余空白字符（多个连续空格/制表符 → 单个空格）。
 * 保留换行符不变，仅处理行内空白。
 */
function collapseExtraSpaces(text: string): string {
  // 逐行处理：每行内多个空格 → 单个空格，同时 trim 首尾空白
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n");
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
