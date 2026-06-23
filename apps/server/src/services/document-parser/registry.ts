// ParserRegistry — plugin-style parser selection.
// Replaces switch(ext) dispatch with a priority-based strategy pattern.

import type { DocumentParser, FileMeta } from "./types.js";

export class ParserRegistry {
  private parsers: DocumentParser[] = [];

  /** Register a parser plugin. Later registrations with the same name overwrite earlier ones. */
  register(parser: DocumentParser): void {
    const idx = this.parsers.findIndex((p) => p.name === parser.name);
    if (idx >= 0) {
      this.parsers[idx] = parser;
    } else {
      this.parsers.push(parser);
    }
  }

  /** Find the first parser that can handle this file, ordered by priority descending. */
  getParser(file: FileMeta): DocumentParser | undefined {
    return this.parsers
      .filter((p) => p.canHandle(file))
      .sort((a, b) => b.priority - a.priority)[0];
  }

  /** List registered parser names (for diagnostics). */
  listParsers(): string[] {
    return this.parsers.map((p) => p.name);
  }
}
