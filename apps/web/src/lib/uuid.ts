// Safe UUID generation — works in both secure and non-secure contexts
// crypto.randomUUID() requires secure context (HTTPS or localhost),
// which fails on http://192.168.x.x accessed from mobile devices.
export function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: manual UUID v4 generation using crypto.getRandomValues()
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  arr[6] = (arr[6] & 0x0f) | 0x40; // Version 4
  arr[8] = (arr[8] & 0x3f) | 0x80; // Variant 1
  const hex = Array.from(arr, (b) => b.toString(16).padStart(2, "0"));
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}
