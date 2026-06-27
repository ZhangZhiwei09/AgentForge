import { ParserRegistry } from "./registry.js";
import { PdfParser } from "./parsers/pdf-parser.js";
import { TextParser } from "./parsers/text-parser.js";
import { WordParser } from "./parsers/word-parser.js";
import { ImageParser } from "./parsers/image-parser.js";
import { AudioParser } from "./parsers/audio-parser.js";
import { VideoParser } from "./parsers/video-parser.js";

export type { DocumentParser, FileMeta, ParsedDocument } from "./types.js";
export { ParserRegistry } from "./registry.js";
export { TextParser } from "./parsers/text-parser.js";
export { PdfParser } from "./parsers/pdf-parser.js";
export { WordParser } from "./parsers/word-parser.js";
export { ImageParser } from "./parsers/image-parser.js";
export { AudioParser } from "./parsers/audio-parser.js";
export { VideoParser } from "./parsers/video-parser.js";

// Lazy singleton — register all built-in parsers on first access
let _instance: ParserRegistry | undefined;

export function getParserRegistry(): ParserRegistry {
  if (!_instance) {
    _instance = new ParserRegistry();
    // 优先级: PDF(50) > Word(40) > Image(30) > Video(25) > Audio(20) > Text(10)
    _instance.register(new PdfParser());
    _instance.register(new WordParser());
    _instance.register(new ImageParser());
    _instance.register(new VideoParser());
    _instance.register(new AudioParser());
    _instance.register(new TextParser());     // catch-all（最低优先级）
  }
  return _instance;
}
