/**
 * Shared utility for detecting AbortError in the frontend.
 *
 * Usage:
 *   import { isAbortError } from "@/lib/abort-utils";
 *   if (isAbortError(err)) { ... }
 */

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
