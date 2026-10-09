import type { AgentFlowDTO, AgentFlowNode } from "@agentforge/shared-types";

function node(id: string, type: AgentFlowNode["type"], x: number, y: number): AgentFlowNode {
  return {
    id, type, name: id, position: { x, y },
    role: type === "agent" ? { name: `${id} expert`, description: "", systemPrompt: "Use only the supplied facts." } : null,
    task: type === "agent" ? "Report a conclusion and evidence." : "",
    inputs: type === "agent" ? { question: { source: "task", path: [] } } : {},
    outputs: type === "agent" ? [
      { name: "conclusion", type: "string", required: true },
      { name: "evidence", type: "array", required: true },
    ] : [],
    execution: { tools: [], maxIterations: 5, timeoutMs: 60000 },
    condition: null,
  };
}

export function flowFixture(): AgentFlowDTO {
  const frontend = node("frontend", "agent", 240, 160);
  frontend.outputs.push(
    { name: "need_escalation", type: "boolean", required: true },
    { name: "escalation_reason", type: "string", required: false },
    { name: "context_for_backend", type: "object", required: true },
  );
  const backend = node("backend", "agent", 720, 80);
  backend.inputs.facts = { source: "node", nodeId: "frontend", path: ["context_for_backend"] };
  const leader = node("leader", "agent", 960, 80);
  leader.inputs.frontend = { source: "node", nodeId: "frontend", path: [] };
  leader.inputs.backend = { source: "node", nodeId: "backend", path: [] };
  leader.outputs = [
    { name: "frontend_score", type: "number", required: true },
    { name: "backend_score", type: "number", required: true },
    { name: "frontend_breakdown", type: "object", required: true },
    { name: "backend_breakdown", type: "object", required: true },
    { name: "reasoning", type: "string", required: true },
    { name: "synthesis", type: "string", required: true },
    { name: "missing_fields", type: "array", required: true },
    { name: "message", type: "string", required: true },
  ];
  const gate = node("escalate", "condition", 480, 160);
  gate.condition = {
    reference: { source: "node", nodeId: "frontend", path: ["need_escalation"] },
    operator: "eq", value: true,
  };
  return {
    id: "canvas-regression", name: "Canvas regression", scene: "diagnosis",
    draftRevision: 1, publishedVersion: 0, publishedRevision: 0, enabled: false, archived: false,
    updatedAt: "2026-10-08T00:00:00Z",
    draft: {
      schemaVersion: 1,
      nodes: [node("start", "start", 0, 160), frontend, backend, leader, gate,
        node("fast_end", "end", 720, 300), node("end", "end", 1200, 80)],
      edges: [
        { id: "start_frontend", source: "start", target: "frontend", branch: null },
        { id: "frontend_escalate", source: "frontend", target: "escalate", branch: null },
        { id: "escalate_backend", source: "escalate", target: "backend", branch: "true" },
        { id: "escalate_fast", source: "escalate", target: "fast_end", branch: "false" },
        { id: "backend_leader", source: "backend", target: "leader", branch: null },
        { id: "leader_end", source: "leader", target: "end", branch: null },
      ],
      diagnosisBindings: { frontend: "frontend", backend: "backend", leader: "leader" },
      outputAdapter: "diagnosis_v1",
      limits: { timeoutMs: 180000, maxTotalIterations: 50 },
    },
  };
}
