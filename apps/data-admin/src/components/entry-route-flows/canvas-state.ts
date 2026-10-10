import type { Node, NodeChange } from "@xyflow/react";
import type { EntryRouteDefinition, EntryRouteNode } from "@agentforge/shared-types";

export type EntryCanvasNode = Node<{ config: EntryRouteNode; visited: boolean; invalid: boolean }, "entry">;

export function syncEntryCanvas(
  previous: EntryCanvasNode[], definition: EntryRouteDefinition, selected: string | null,
  visited: Set<string>, invalid: Set<string>,
): EntryCanvasNode[] {
  const byId = new Map(previous.map((node) => [node.id, node]));
  const next = definition.nodes.map((config): EntryCanvasNode => {
    const existing = byId.get(config.id);
    const data = existing && existing.data.config === config &&
      existing.data.visited === visited.has(config.id) && existing.data.invalid === invalid.has(config.id)
      ? existing.data : { config, visited: visited.has(config.id), invalid: invalid.has(config.id) };
    const position = existing && (existing.dragging ||
      (existing.position.x === config.position.x && existing.position.y === config.position.y)) ? existing.position : config.position;
    if (existing && existing.data === data && existing.position === position && existing.selected === (config.id === selected)) return existing;
    return { ...existing, id: config.id, type: "entry", data, position, selected: config.id === selected };
  });
  return next.length === previous.length && next.every((node, i) => node === previous[i]) ? previous : next;
}

export function commitEntryPositions(definition: EntryRouteDefinition, changes: NodeChange<EntryCanvasNode>[]): EntryRouteDefinition {
  const positions = new Map<string, EntryRouteNode["position"]>();
  for (const change of changes) if (change.type === "position" && change.position && change.dragging !== true) positions.set(change.id, change.position);
  let changed = false;
  const nodes = definition.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position || (node.position.x === position.x && node.position.y === position.y)) return node;
    changed = true;
    return { ...node, position };
  });
  return changed ? { ...definition, nodes } : definition;
}

export function entryDefinitionKey(definition: EntryRouteDefinition): string {
  return JSON.stringify(definition, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
}
