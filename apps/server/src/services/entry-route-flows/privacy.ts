// Runs contain bounded summaries, never request headers or conversation history.
export function redactEntryText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:api[_ -]?key|password|密码|secret|authorization|access[_ -]?token)\s*[:=]\s*)[^\s,;，；]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/\b1[3-9]\d{9}\b/g, "[PHONE]");
}

export function redactEntryValue(value: unknown): unknown {
  if (typeof value === "string") return redactEntryText(value);
  if (Array.isArray(value)) return value.map(redactEntryValue);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key, /^(password|secret|authorization|api[_-]?key|access[_-]?token)$/i.test(key) ? "[REDACTED]" : redactEntryValue(item),
    ]),
  );
  return value;
}
