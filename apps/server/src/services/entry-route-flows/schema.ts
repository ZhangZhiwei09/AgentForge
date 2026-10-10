import { z } from "zod";
import type { EntryRouteDefinition, EntryRouteValidation } from "@agentforge/shared-types";

export const ENTRY_LIMITS = {
  nodes: 30, edges: 60, words: 50, wordLength: 128, answerLength: 8000,
  suggestions: 5, suggestionLength: 200, messageLength: 16000,
} as const;

const identifier = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const text = (max: number) => z.string().max(max).refine((s) => s.trim().length > 0, "不能为空");
const suggestions = z.array(text(ENTRY_LIMITS.suggestionLength)).max(ENTRY_LIMITS.suggestions);
const words = z.array(text(ENTRY_LIMITS.wordLength)).max(ENTRY_LIMITS.words);
const base = {
  id: identifier,
  name: text(200),
  position: z.object({ x: z.number().finite().min(-100000).max(100000), y: z.number().finite().min(-100000).max(100000) }).strict(),
};
const handoff = z.object({
  withinHours: text(ENTRY_LIMITS.answerLength),
  outsideHours: text(ENTRY_LIMITS.answerLength),
  suggestions,
}).strict();

export const entryDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(z.discriminatedUnion("type", [
    z.object({ ...base, type: z.literal("start") }).strict(),
    z.object({
      ...base, type: z.literal("condition"),
      condition: z.object({
        operator: z.enum(["contains_any", "contains_all", "equals_any"]),
        words: words.min(1),
        excludeAny: words,
        ignoreCase: z.boolean(),
        stripTrailingPunctuation: z.boolean(),
      }).strict(),
    }).strict(),
    z.object({ ...base, type: z.literal("reply"), answer: text(ENTRY_LIMITS.answerLength), suggestions }).strict(),
    z.object({ ...base, type: z.literal("route"), target: z.enum(["CHAT", "TASK", "HUMAN", "DIAGNOSIS"]), handoff: handoff.optional() }).strict(),
    z.object({ ...base, type: z.literal("continue") }).strict(),
  ])).min(1).max(ENTRY_LIMITS.nodes),
  edges: z.array(z.object({
    id: identifier, source: identifier, target: identifier,
    branch: z.enum(["true", "false"]).nullable(),
  }).strict()).max(ENTRY_LIMITS.edges),
}).strict();

export class EntryFlowError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 | 500 | 503,
    public readonly errors: EntryRouteValidation["errors"] = [],
  ) { super(message); }
}

// Shared by keyword and message normalization; only these trailing characters are removed.
export function normalizeEntryText(
  value: string,
  condition: Extract<EntryRouteDefinition["nodes"][number], { type: "condition" }>["condition"],
): string {
  let normalized = value.trim();
  if (condition.ignoreCase) normalized = normalized.toLowerCase();
  if (condition.stripTrailingPunctuation) normalized = normalized.replace(/[\s!！。.,，]+$/, "");
  return normalized;
}

export function validateEntryDefinition(value: unknown): EntryRouteValidation {
  const parsed = entryDefinitionSchema.safeParse(value);
  if (!parsed.success) return {
    valid: false,
    errors: parsed.error.issues.map((issue) => {
      const index = issue.path[0] === "nodes" && typeof issue.path[1] === "number" ? issue.path[1] : null;
      const raw = value as { nodes?: Array<{ id?: string }> } | null;
      return {
        path: issue.path.join("."), message: issue.message,
        ...(index !== null && typeof raw?.nodes?.[index]?.id === "string" ? { nodeId: raw.nodes[index].id } : {}),
      };
    }),
  };

  const definition = parsed.data;
  const errors: EntryRouteValidation["errors"] = [];
  const add = (path: string, message: string, nodeId?: string) => errors.push({ path, message, ...(nodeId ? { nodeId } : {}) });
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const edgeIds = new Set<string>();
  if (nodes.size !== definition.nodes.length) add("nodes", "节点 ID 重复");
  const starts = definition.nodes.filter((node) => node.type === "start");
  if (starts.length !== 1) add("nodes", "必须有且仅有一个开始节点");
  for (const [index, edge] of definition.edges.entries()) {
    if (edgeIds.has(edge.id)) add(`edges.${index}.id`, "连线 ID 重复");
    edgeIds.add(edge.id);
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) add(`edges.${index}`, "连线引用了不存在的节点");
    if (edge.source === edge.target) add(`edges.${index}`, "不能连接到自身", edge.source);
  }
  for (const [index, node] of definition.nodes.entries()) {
    const outgoing = definition.edges.filter((edge) => edge.source === node.id);
    const incoming = definition.edges.filter((edge) => edge.target === node.id);
    const path = `nodes.${index}`;
    if (node.type === "start") {
      if (incoming.length || outgoing.length !== 1 || outgoing[0]?.branch !== null) add(path, "开始节点无入边且必须有一个普通出口", node.id);
    } else if (node.type === "condition") {
      if (outgoing.length !== 2 || outgoing.filter((e) => e.branch === "true").length !== 1 || outgoing.filter((e) => e.branch === "false").length !== 1) {
        add(path, "条件节点必须各有一个 true 和 false 出口", node.id);
      }
      const { condition } = node;
      if (condition.stripTrailingPunctuation && condition.operator !== "equals_any") add(`${path}.condition`, "末尾标点规范化仅支持精确匹配", node.id);
      const normalized = condition.words.map((word) => normalizeEntryText(word, condition));
      const excluded = condition.excludeAny.map((word) => normalizeEntryText(word, condition));
      if ([...normalized, ...excluded].some((word) => !word)) add(`${path}.condition`, "规范化后的关键词不能为空", node.id);
      if (new Set(normalized).size !== normalized.length || new Set(excluded).size !== excluded.length) add(`${path}.condition`, "规范化后的关键词不能重复", node.id);
      if (normalized.some((word) => excluded.includes(word))) add(`${path}.condition`, "匹配词与排除词不能相同", node.id);
    } else if (outgoing.length) add(path, "结束节点不能有出口", node.id);
    if (node.type === "route" && node.handoff && node.target !== "HUMAN") add(`${path}.handoff`, "仅 HUMAN 可以配置转接话术", node.id);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) { add("edges", "流程不能包含循环", id); return; }
    if (visited.has(id) || !nodes.has(id)) return;
    visiting.add(id);
    for (const edge of definition.edges.filter((e) => e.source === id)) visit(edge.target);
    visiting.delete(id);
    visited.add(id);
  }
  if (starts.length === 1) visit(starts[0].id);
  for (const node of definition.nodes) if (!visited.has(node.id)) add("nodes", "节点不可从开始到达", node.id);
  if (!definition.nodes.some((node) => node.type === "continue" && visited.has(node.id))) add("nodes", "必须有可达的 continue 兜底节点");
  return { valid: errors.length === 0, errors };
}

export function parseEntryDefinition(value: unknown): EntryRouteDefinition {
  const validation = validateEntryDefinition(value);
  if (!validation.valid) throw new EntryFlowError("一级流程校验失败", 400, validation.errors);
  return entryDefinitionSchema.parse(value);
}
