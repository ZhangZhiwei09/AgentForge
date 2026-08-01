import { KnowledgeService } from "../knowledge.js";
import { DiagnosisResponseSchema } from "./schemas.js";
import type { DiagnosisResponse } from "./schemas.js";
import { createInitialDiagnosisState, type DiagnosisState } from "./state.js";
import {
  askClarificationNode,
  checkRequiredFieldsNode,
  classifyIntentNode,
  createQueryMonitoringNode,
  createRetrieveKnowledgeNode,
  decideToolsNode,
  extractEntitiesNode,
  generateDiagnosisNode,
  mergeEvidenceNode,
  selfCheckNode,
  type DiagnosisKnowledgeRetriever,
} from "./nodes.js";
import {
  MockDiagnosisMonitoringTools,
  type DiagnosisMonitoringTools,
} from "./tools/monitoring-tools.js";

export interface DiagnosisServiceDeps {
  knowledgeRetriever?: DiagnosisKnowledgeRetriever;
  monitoringTools?: DiagnosisMonitoringTools;
}

export interface RunDiagnosisInput {
  query: string;
  kbIds?: string[];
}

export class DiagnosisService {
  private readonly knowledgeRetriever: DiagnosisKnowledgeRetriever;
  private readonly monitoringTools: DiagnosisMonitoringTools;

  constructor(deps: DiagnosisServiceDeps = {}) {
    this.knowledgeRetriever = deps.knowledgeRetriever ?? new KnowledgeService();
    this.monitoringTools = deps.monitoringTools ?? new MockDiagnosisMonitoringTools();
  }

  async run(input: RunDiagnosisInput): Promise<DiagnosisResponse> {
    const deps = {
      knowledgeRetriever: this.knowledgeRetriever,
      monitoringTools: this.monitoringTools,
    };

    const retrieveKnowledge = createRetrieveKnowledgeNode(deps);
    const queryMonitoring = createQueryMonitoringNode(deps);

    // Initialize state from input
    let state: DiagnosisState = createInitialDiagnosisState(input);

    // 1. classify_intent
    state = { ...state, ...classifyIntentNode(state) };

    // 2. extract_entities
    state = { ...state, ...extractEntitiesNode(state) };

    // 3. check_required_fields (may short-circuit with clarification)
    state = { ...state, ...checkRequiredFieldsNode(state) };

    if (state.missingFields.length > 0) {
      state = { ...state, ...askClarificationNode(state) };
      return DiagnosisResponseSchema.parse({
        intent: state.intent ?? "unknown",
        status: state.status ?? "failed",
        entities: state.entities,
        missingFields: state.missingFields,
        evidence: state.evidence,
        toolResults: state.toolResults,
        answer: state.answer ?? "诊断流程未生成回答。",
        warnings: state.warnings,
      });
    }

    // 4. retrieve_knowledge
    state = { ...state, ...(await retrieveKnowledge(state)) };

    // 5. decide_tools
    state = { ...state, ...decideToolsNode(state) };

    // 6. query_monitoring (conditional on toolPlan)
    if (state.toolPlan.length > 0) {
      state = { ...state, ...(await queryMonitoring(state)) };
    }

    // 7. merge_evidence
    state = { ...state, ...mergeEvidenceNode(state) };

    // 8. generate_diagnosis
    state = { ...state, ...generateDiagnosisNode(state) };

    // 9. self_check
    state = { ...state, ...selfCheckNode(state) };

    return DiagnosisResponseSchema.parse({
      intent: state.intent ?? "unknown",
      status: state.status ?? "failed",
      entities: state.entities,
      missingFields: state.missingFields,
      evidence: state.evidence,
      toolResults: state.toolResults,
      answer: state.answer ?? "诊断流程未生成回答。",
      warnings: state.warnings,
    });
  }
}

export const diagnosisService = new DiagnosisService();
