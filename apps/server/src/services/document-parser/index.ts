import { ParserRegistry } from "./registry.js";
import { PdfParser } from "./parsers/pdf-parser.js";
import { TextParser } from "./parsers/text-parser.js";

export type { DocumentParser, FileMeta, ParsedDocument } from "./types.js";
export { ParserRegistry } from "./registry.js";
export { TextParser } from "./parsers/text-parser.js";
export { PdfParser } from "./parsers/pdf-parser.js";

// Lazy singleton — register all built-in parsers on first access
let _instance: ParserRegistry | undefined;

export function getParserRegistry(): ParserRegistry {
  if (!_instance) {
    _instance = new ParserRegistry();
    // Higher-priority parsers are checked first
    _instance.register(new PdfParser());     // priority 50
    _instance.register(new TextParser());     // priority 10 (catch-all)
  }
  return _instance;
}
