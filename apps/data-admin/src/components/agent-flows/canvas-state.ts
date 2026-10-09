import type { Node, NodeChange } from "@xyflow/react";
import type {
  AgentFlowDefinition, AgentFlowNode, AgentFlowNodeRecord,
} from "@agentforge/shared-types";

export type CanvasNode = Node<{ config: AgentFlowNode; state?: string; core?: string }, "flow">;

export function syncCanvasNodes(
  previous: CanvasNode[],
  definition: AgentFlowDefinition,
  selected: string | null,
  records: Record<string, AgentFlowNodeRecord>,
): CanvasNode[] {
  const byId = new Map(previous.map((node) => [node.id, node]));
  const bindings = Object.entries(definition.diagnosisBindings);
  const nodes = definition.nodes.map((config): CanvasNode => {
    const existing = byId.get(config.id);
    const state = records[config.id]?.status;
    const core = bindings.find(([, id]) => id === config.id)?.[0];
    const isSelected = config.id === selected;
    const data = existing && existing.data.config === config &&
      existing.data.state === state && existing.data.core === core
      ? existing.data : { config, state, core };
    const position = existing && (existing.dragging ||
      (existing.position.x === config.position.x && existing.position.y === config.position.y))
      ? existing.position : config.position;

    if (existing && existing.data === data && existing.position === position &&
        existing.selected === isSelected) {
      return existing;
    }
    // Retain measured dimensions and React Flow interaction state across config updates.
    return { ...existing, id: config.id, type: "flow", position, selected: isSelected, data };
  });
  return nodes.length === previous.length && nodes.every((node, index) => node === previous[index])
    ? previous : nodes;
}

export function commitCanvasPositions(
  definition: AgentFlowDefinition,
  changes: NodeChange<CanvasNode>[],
): AgentFlowDefinition {
  const positions = new Map<string, AgentFlowNode["position"]>();
  for (const change of changes) {
    if (change.type === "position" && change.position && change.dragging !== true) {
      positions.set(change.id, change.position);
    }
  }
  if (!positions.size) return definition;

  let changed = false;
  const nodes = definition.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position || (node.position.x === position.x && node.position.y === position.y)) return node;
    changed = true;
    return { ...node, position: { ...position } };
  });
  return changed ? { ...definition, nodes } : definition;
}
