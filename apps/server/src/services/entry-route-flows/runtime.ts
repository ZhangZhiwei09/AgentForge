import type { EntryRouteDefinition, EntryRouteNodeRecord, EntryRouteResult } from "@agentforge/shared-types";
import { ENTRY_LIMITS, normalizeEntryText, parseEntryDefinition } from "./schema.js";

export interface EntryExecution {
  result: EntryRouteResult;
  terminalNodeId: string;
  records: EntryRouteNodeRecord[];
  durationMs: number;
}

export function executeEntryFlow(
  value: EntryRouteDefinition,
  message: string,
  signal?: AbortSignal,
): EntryExecution {
  const started = Date.now();
  signal?.throwIfAborted();
  if (!message.trim() || message.length > ENTRY_LIMITS.messageLength) throw new Error("消息不能为空且不能超过 16000 字符");
  const definition = parseEntryDefinition(value);
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  let currentId = definition.nodes.find((node) => node.type === "start")!.id;
  const records: EntryRouteNodeRecord[] = [];
  for (let step = 0; step < ENTRY_LIMITS.nodes; step++) {
    signal?.throwIfAborted();
    const current = byId.get(currentId)!;
    const nodeStart = Date.now();
    const record: EntryRouteNodeRecord = { nodeId: current.id, name: current.name, type: current.type, durationMs: 0 };
    let branch: "true" | "false" | null = null;
    let result: EntryRouteResult | undefined;
    if (current.type === "condition") {
      const config = current.condition;
      const text = normalizeEntryText(message, config);
      const words = config.words.map((word) => normalizeEntryText(word, config));
      const excluded = config.excludeAny.map((word) => normalizeEntryText(word, config));
      const matched = !excluded.some((word) => text.includes(word)) && (
        config.operator === "equals_any" ? words.includes(text) :
          config.operator === "contains_all" ? words.every((word) => text.includes(word)) :
            words.some((word) => text.includes(word))
      );
      branch = matched ? "true" : "false";
      record.matched = matched;
      record.branch = branch;
    } else if (current.type === "reply") result = { action: "reply", answer: current.answer, suggestions: current.suggestions };
    else if (current.type === "route") result = { action: "route", target: current.target, ...(current.handoff ? { handoff: current.handoff } : {}) };
    else if (current.type === "continue") result = { action: "continue" };
    record.durationMs = Date.now() - nodeStart;
    records.push(record);
    if (result) return { result, terminalNodeId: current.id, records, durationMs: Date.now() - started };
    const next = definition.edges.find((edge) => edge.source === current.id && edge.branch === branch);
    if (!next || !byId.has(next.target)) throw new Error(`节点 ${current.id} 缺少出口`);
    currentId = next.target;
  }
  throw new Error("一级流程执行超过节点上限");
}
