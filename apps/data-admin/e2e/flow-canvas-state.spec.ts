import { test, expect } from "@playwright/test";
import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { commitCanvasPositions, syncCanvasNodes, type CanvasNode } from "../src/components/agent-flows/canvas-state";
import { flowFixture } from "./fixtures/agent-flow";

function measuredNodes() {
  const definition = flowFixture().draft;
  const nodes = applyNodeChanges(definition.nodes.map((node) => ({
    type: "dimensions" as const, id: node.id, dimensions: { width: 210, height: 100 },
  })), syncCanvasNodes([], definition, null, {}));
  return { definition, nodes };
}

test("unchanged configuration retains node identities and measured dimensions", () => {
  const { definition, nodes } = measuredNodes();
  expect(syncCanvasNodes(nodes, definition, null, {})).toBe(nodes);
  expect(nodes.every((node) => node.measured?.width === 210)).toBeTruthy();
});

test("drag frames retain dimensions without mutating the business definition", () => {
  const { definition, nodes } = measuredNodes();
  const changes: NodeChange<CanvasNode>[] = [
    { type: "position", id: "backend", position: { x: 800, y: 120 }, dragging: true },
  ];
  const moved = applyNodeChanges(changes, nodes);
  expect(commitCanvasPositions(definition, changes)).toBe(definition);
  const refreshed = syncCanvasNodes(moved, definition, "backend", {});
  const backend = refreshed.find((node) => node.id === "backend")!;
  expect(backend.position).toEqual({ x: 800, y: 120 });
  expect(backend.measured).toEqual({ width: 210, height: 100 });
  expect(backend.dragging).toBe(true);
  expect(refreshed.find((node) => node.id === "frontend")).toBe(nodes.find((node) => node.id === "frontend"));
});

test("drag stop commits only changed positions and keeps all measurements", () => {
  const { definition, nodes } = measuredNodes();
  const changes: NodeChange<CanvasNode>[] = [
    { type: "position", id: "backend", position: { x: 800, y: 120 }, dragging: false },
  ];
  const committed = commitCanvasPositions(definition, changes);
  expect(committed.nodes.find((node) => node.id === "backend")?.position).toEqual({ x: 800, y: 120 });
  expect(committed.nodes.find((node) => node.id === "frontend")).toBe(definition.nodes.find((node) => node.id === "frontend"));
  expect(committed.edges).toBe(definition.edges);
  expect(definition.nodes.find((node) => node.id === "backend")?.position).toEqual({ x: 720, y: 80 });
  const refreshed = syncCanvasNodes(applyNodeChanges(changes, nodes), committed, null, {});
  expect(refreshed.every((node) => node.measured?.width === 210)).toBeTruthy();
  expect(refreshed.find((node) => node.id === "frontend")).toBe(nodes.find((node) => node.id === "frontend"));
  expect(committed.nodes.every((node) => !("measured" in node) && !("dragging" in node))).toBeTruthy();
});

test("keyboard movement commits and unchanged coordinates do not dirty the draft", () => {
  const { definition } = measuredNodes();
  expect(commitCanvasPositions(definition, [
    { type: "position", id: "backend", position: { x: 720, y: 80 }, dragging: false },
  ])).toBe(definition);
  const changed = commitCanvasPositions(definition, [
    { type: "position", id: "backend", position: { x: 725, y: 80 } },
  ]);
  expect(changed.nodes.find((node) => node.id === "backend")?.position.x).toBe(725);
});

test("measurement and selection changes never enter the saved definition", () => {
  const { definition } = measuredNodes();
  expect(commitCanvasPositions(definition, [
    { type: "dimensions", id: "backend", dimensions: { width: 210, height: 140 } },
    { type: "select", id: "backend", selected: true },
  ])).toBe(definition);
});

test("mixed drag changes commit finished nodes without resetting active nodes", () => {
  const { definition, nodes } = measuredNodes();
  const changes: NodeChange<CanvasNode>[] = [
    { type: "position", id: "frontend", position: { x: 280, y: 190 }, dragging: true },
    { type: "position", id: "backend", position: { x: 800, y: 120 }, dragging: false },
  ];
  const committed = commitCanvasPositions(definition, changes);
  expect(committed.nodes.find((node) => node.id === "frontend")).toBe(definition.nodes.find((node) => node.id === "frontend"));
  expect(committed.nodes.find((node) => node.id === "backend")?.position).toEqual({ x: 800, y: 120 });
  const refreshed = syncCanvasNodes(applyNodeChanges(changes, nodes), committed, null, {});
  expect(refreshed.find((node) => node.id === "frontend")?.position).toEqual({ x: 280, y: 190 });
  expect(refreshed.find((node) => node.id === "frontend")?.dragging).toBe(true);
  expect(refreshed.every((node) => node.measured?.width === 210)).toBeTruthy();
  const finished = commitCanvasPositions(committed, [
    { type: "position", id: "frontend", position: { x: 280, y: 190 }, dragging: false },
  ]);
  expect(finished.nodes.find((node) => node.id === "frontend")?.position).toEqual({ x: 280, y: 190 });
  expect(finished.nodes.find((node) => node.id === "backend")).toBe(committed.nodes.find((node) => node.id === "backend"));
});

test("config edits and refreshed server objects retain measurements", () => {
  const { definition, nodes } = measuredNodes();
  const edited = {
    ...definition, nodes: definition.nodes.map((node) =>
      node.id === "backend" ? { ...node, name: "Edited backend expert" } : node),
  };
  const updated = syncCanvasNodes(nodes, edited, null, {});
  expect(updated.find((node) => node.id === "backend")?.data.config.name).toBe("Edited backend expert");
  expect(updated.find((node) => node.id === "frontend")).toBe(nodes.find((node) => node.id === "frontend"));
  const refreshed = syncCanvasNodes(updated, structuredClone(edited), null, {});
  expect(refreshed.every((node) => node.measured?.width === 210)).toBeTruthy();
});

test("run status changes keep canvas geometry and unaffected node identities", () => {
  const { definition, nodes } = measuredNodes();
  const updated = syncCanvasNodes(nodes, definition, null, {
    backend: { nodeId: "backend", name: "backend", type: "agent", status: "running" },
  });
  expect(updated.find((node) => node.id === "backend")?.data.state).toBe("running");
  expect(updated.find((node) => node.id === "backend")?.measured).toEqual({ width: 210, height: 100 });
  expect(updated.find((node) => node.id === "frontend")).toBe(nodes.find((node) => node.id === "frontend"));
});

test("adding and removing nodes preserves measurements on remaining nodes", () => {
  const { definition, nodes } = measuredNodes();
  const extra = { ...definition.nodes[2], id: "extra" };
  const added = syncCanvasNodes(nodes, { ...definition, nodes: [...definition.nodes, extra] }, null, {});
  expect(added.find((node) => node.id === "extra")?.measured).toBeUndefined();
  const removed = syncCanvasNodes(added, {
    ...definition, nodes: definition.nodes.filter((node) => node.id !== "backend"),
  }, null, {});
  expect(removed.some((node) => node.id === "backend" || node.id === "extra")).toBe(false);
  expect(removed.find((node) => node.id === "frontend")).toBe(nodes.find((node) => node.id === "frontend"));
});
