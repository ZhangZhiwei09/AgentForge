// Blackboard — shared context store for Multi-Agent collaboration
// All agents read/write to this shared "whiteboard" for cumulative knowledge building
import type { BlackboardEntry } from "@agentforge/shared-types";

export class Blackboard {
  private entries: Map<string, BlackboardEntry> = new Map();
  private history: BlackboardEntry[] = [];

  /** Write a value to the blackboard (with version control) */
  write(
    key: string,
    value: unknown,
    agentName: string,
    metadata?: BlackboardEntry["metadata"],
  ): BlackboardEntry {
    const prevEntry = this.entries.get(key);
    const entry: BlackboardEntry = {
      key,
      value,
      writtenBy: agentName,
      timestamp: new Date().toISOString(),
      version: (prevEntry?.version ?? 0) + 1,
      metadata,
    };
    this.entries.set(key, entry);
    this.history.push(entry);
    return entry;
  }

  /** Read a value by key */
  read(key: string): unknown | undefined {
    return this.entries.get(key)?.value;
  }

  /** Get the full entry by key (including metadata) */
  getEntry(key: string): BlackboardEntry | undefined {
    return this.entries.get(key);
  }

  /** Check if a key exists */
  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Get a snapshot of all current entries as a plain object */
  snapshot(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of this.entries) {
      result[key] = entry.value;
    }
    return result;
  }

  /** Get all entries written by a specific agent */
  entriesByAgent(agentName: string): BlackboardEntry[] {
    return this.history.filter((e) => e.writtenBy === agentName);
  }

  /** Get the full version history for a key */
  getHistory(key: string): BlackboardEntry[] {
    return this.history.filter((e) => e.key === key);
  }

  /** Delete a key (only the writer can delete) */
  delete(key: string, agentName: string): boolean {
    const entry = this.entries.get(key);
    if (entry && entry.writtenBy === agentName) {
      this.entries.delete(key);
      return true;
    }
    return false;
  }

  /** Get all keys */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Get entry count */
  get size(): number {
    return this.entries.size;
  }

  /** Get total history count (all versions) */
  get historyCount(): number {
    return this.history.length;
  }

  /** Serialize for DB persistence */
  serialize(): Record<string, unknown> {
    return this.snapshot();
  }

  /** Convert to context string for injection into Agent System Prompt */
  toContextString(): string {
    if (this.entries.size === 0) return "(Blackboard 为空)";

    let ctx = "## 共享 Blackboard (最新值):\n";
    for (const [key, entry] of this.entries) {
      const val =
        typeof entry.value === "string"
          ? entry.value
          : JSON.stringify(entry.value);
      ctx += `- **${key}** (由 ${entry.writtenBy} 写入, v${entry.version}): ${val.substring(0, 300)}\n`;
    }
    return ctx;
  }

  /** Clear all entries */
  clear(): void {
    this.entries.clear();
    this.history = [];
  }
}
