// @agentforge/cui — 流式卡片组件库

// ── Protocol ──
export {
  CardProtocolMeta,
  CARD_PROTOCOL_VERSION,
  CARD_FENCE_TYPE_MAP,
  CARD_FENCE_TYPES,
  CONTENT_BLOCK_TYPES,
} from "./protocol/types";
export type { ParsedCard, ParsedCardResult, SSEBaseChunk } from "./protocol/types";

export {
  OrderCardDataSchema,
  PolicyCardDataSchema,
  ActionCardDataSchema,
  StatusCardDataSchema,
  TableBlockDataSchema,
  ContentBlockSchema,
  ContentBlockChunkSchema,
  ActionStyleEnum,
  StatusEnum,
  StepStatusEnum,
  getPartialSchema,
} from "./protocol/schemas";

export { parseCard, validateCardData } from "./protocol/parser";

// ── Parsing ──
export {
  extractCardBlocks,
  hasUnclosedFence,
  tryParseStreamingCard,
} from "./parsing/card-parser";
export type { ParsedResult, StreamingCard } from "./parsing/card-parser";

// ── Rendering ──
export { RichMessageRenderer, MarkdownRenderer } from "./rendering";

// ── Cards ──
export {
  ActionCard,
  OrderCard,
  PolicyCard,
  StatusCard,
  TableCard,
  DiagnosisCard,
  ClarificationCard,
  WaitingInputCard,
} from "./cards";

// ── Utils ──
export { cn, parseSSEChunk, blockKey, dedupeBlocks } from "./utils";

// ── Re-export shared types for convenience ──
export type {
  ContentBlock,
  ContentBlockType,
  OrderCardData,
  PolicyCardData,
  ActionCardData,
  StatusCardData,
  TableBlockData,
  ContentBlockChunk,
  CardFenceType,
  DiagnosisProgress,
  DiagnosisPhase,
  TextBlock,
  OrderCardBlock,
  PolicyCardBlock,
  ActionCardBlock,
  StatusCardBlock,
  TableBlock,
} from "@agentforge/shared-types";
