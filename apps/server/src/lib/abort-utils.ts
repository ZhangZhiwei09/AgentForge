/**
 * Shared utility for detecting AbortError across the codebase.
 *
 * Usage:
 *   import { isAbortError, isCancelled } from "../lib/abort-utils.js";
 *   if (isCancelled(err, signal)) { ... }
 */

/** Check if an error is an AbortError (DOMException or Error with name "AbortError") */
export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

/** Check if execution was cancelled — either via AbortError or signal already aborted */
export function isCancelled(err: unknown, signal?: AbortSignal): boolean {
  return isAbortError(err) || signal?.aborted === true;
}
