import type {
  DiagnosisEntities,
  DiagnosisEvidence,
  DiagnosisIntent,
  DiagnosisKnowledgeEvidence,
  DiagnosisStatus,
  DiagnosisToolCall,
  DiagnosisToolResult,
} from "./schemas.js";

export interface DiagnosisState {
  query: string;
  kbIds?: string[];
  intent?: DiagnosisIntent;
  entities: DiagnosisEntities;
  missingFields: string[];
  retrievedDocs: DiagnosisKnowledgeEvidence[];
  toolPlan: DiagnosisToolCall[];
  toolResults: DiagnosisToolResult[];
  evidence: DiagnosisEvidence[];
  status?: DiagnosisStatus;
  answer?: string;
  warnings: string[];
}

export function createInitialDiagnosisState(input: {
  query: string;
  kbIds?: string[];
}): DiagnosisState {
  return {
    query: input.query,
    kbIds: input.kbIds,
    entities: {},
    missingFields: [],
    retrievedDocs: [],
    toolPlan: [],
    toolResults: [],
    evidence: [],
    warnings: [],
  };
}

