export type FlowFieldType = "string" | "number" | "boolean" | "object" | "array";
export interface FlowValueRef {
  source: "task" | "node";
  nodeId?: string | null;
  path: string[];
}
export interface FlowOutputField {
  name: string;
  type: FlowFieldType;
  required: boolean;
}
export interface AgentFlowNode {
  id: string;
  type: "start" | "agent" | "condition" | "end";
  name: string;
  position: { x: number; y: number };
  role: { name: string; description: string; systemPrompt: string } | null;
  task: string;
  inputs: Record<string, FlowValueRef>;
  outputs: FlowOutputField[];
  execution: { tools: string[]; maxIterations: number; timeoutMs: number };
  condition: {
    reference: FlowValueRef;
    operator: "eq" | "ne";
    value: string | number | boolean | null;
  } | null;
}
export interface AgentFlowEdge {
  id: string;
  source: string;
  target: string;
  branch: "true" | "false" | null;
}
export interface AgentFlowDefinition {
  schemaVersion: 1;
  nodes: AgentFlowNode[];
  edges: AgentFlowEdge[];
  diagnosisBindings: { frontend: string; backend: string; leader: string };
  outputAdapter: "diagnosis_v1";
  limits: { timeoutMs: number; maxTotalIterations: number };
}
export interface AgentFlowDTO {
  id: string;
  name: string;
  scene: string;
  draft: AgentFlowDefinition;
  draftRevision: number;
  publishedVersion: number;
  publishedRevision: number;
  enabled: boolean;
  archived: boolean;
  updatedAt: string;
}
export interface AgentFlowNodeRecord {
  nodeId: string;
  name: string;
  type: AgentFlowNode["type"];
  status: "running" | "completed" | "failed" | "skipped" | "cancelled";
  inputs?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}
export interface AgentFlowRunDTO {
  id: string;
  flowId: string;
  version: number;
  draftRevision: number | null;
  test: boolean;
  status: "running" | "waiting_input" | "completed" | "failed" | "cancelled";
  records: Record<string, AgentFlowNodeRecord>;
  output: Record<string, unknown> | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
}
export interface AgentFlowEvent {
  type: "flow_started" | "node_started" | "node_completed" | "node_failed" |
    "flow_completed" | "flow_failed" | "flow_waiting_input" | "flow_cancelled";
  runId?: string;
  nodeId?: string;
  inputs?: Record<string, unknown>;
  output?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
  skippedNodes?: string[];
}
