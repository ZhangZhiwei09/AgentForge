export type EntryRouteTarget = "CHAT" | "TASK" | "HUMAN" | "DIAGNOSIS";
export type EntryNodeType = "start" | "condition" | "reply" | "route" | "continue";

export interface EntryHandoff {
  withinHours: string;
  outsideHours: string;
  suggestions: string[];
}

export type EntryRouteResult =
  | { action: "reply"; answer: string; suggestions: string[] }
  | { action: "route"; target: EntryRouteTarget; handoff?: EntryHandoff }
  | { action: "continue" };

interface EntryNodeBase {
  id: string;
  name: string;
  position: { x: number; y: number };
}

export type EntryRouteNode = EntryNodeBase & (
  | { type: "start" }
  | {
      type: "condition";
      condition: {
        operator: "contains_any" | "contains_all" | "equals_any";
        words: string[];
        excludeAny: string[];
        ignoreCase: boolean;
        stripTrailingPunctuation: boolean;
      };
    }
  | { type: "reply"; answer: string; suggestions: string[] }
  | { type: "route"; target: EntryRouteTarget; handoff?: EntryHandoff }
  | { type: "continue" }
);

export interface EntryRouteEdge {
  id: string;
  source: string;
  target: string;
  branch: "true" | "false" | null;
}

export interface EntryRouteDefinition {
  schemaVersion: 1;
  nodes: EntryRouteNode[];
  edges: EntryRouteEdge[];
}

export interface EntryRouteFlowDTO {
  id: string;
  name: string;
  draft: EntryRouteDefinition;
  draftRevision: number;
  published: EntryRouteDefinition | null;
  publishedVersion: number;
  publishedRevision: number;
  enabled: boolean;
  archived: boolean;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntryRouteNodeRecord {
  nodeId: string;
  name: string;
  type: EntryNodeType;
  matched?: boolean;
  branch?: "true" | "false";
  durationMs: number;
}

export interface EntryRouteRunDTO {
  id: string;
  flowId: string;
  version: number;
  draftRevision: number | null;
  snapshot: EntryRouteDefinition;
  actorId: string;
  conversationId: string | null;
  assistantMessageId: string | null;
  test: boolean;
  status: "running" | "completed" | "failed" | "cancelled";
  inputSummary: string;
  records: EntryRouteNodeRecord[];
  output: EntryRouteResult | null;
  terminalNodeId: string | null;
  error: string | null;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntryRouteValidation {
  valid: boolean;
  errors: Array<{ path: string; message: string; nodeId?: string }>;
}

export interface EntryRouteRunPage {
  items: EntryRouteRunDTO[];
  total: number;
  page: number;
  pageSize: number;
}
