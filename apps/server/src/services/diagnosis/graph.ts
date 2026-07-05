import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
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
  routeAfterRequiredFields,
  routeAfterToolDecision,
  selfCheckNode,
  type DiagnosisKnowledgeRetriever,
} from "./nodes.js";
import {
  MockDiagnosisMonitoringTools,
  type DiagnosisMonitoringTools,
} from "./tools/monitoring-tools.js";

const DiagnosisStateAnnotation = Annotation.Root({
  query: Annotation<string>(),
  kbIds: Annotation<string[] | undefined>(),
  intent: Annotation<DiagnosisState["intent"]>(),
  entities: Annotation<DiagnosisState["entities"]>(),
  missingFields: Annotation<DiagnosisState["missingFields"]>(),
  retrievedDocs: Annotation<DiagnosisState["retrievedDocs"]>(),
  toolPlan: Annotation<DiagnosisState["toolPlan"]>(),
  toolResults: Annotation<DiagnosisState["toolResults"]>(),
  evidence: Annotation<DiagnosisState["evidence"]>(),
  status: Annotation<DiagnosisState["status"]>(),
  answer: Annotation<DiagnosisState["answer"]>(),
  warnings: Annotation<DiagnosisState["warnings"]>(),
});

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
    const app = this.createGraph();
    const state = await app.invoke(createInitialDiagnosisState(input));

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

  private createGraph() {
    const deps = {
      knowledgeRetriever: this.knowledgeRetriever,
      monitoringTools: this.monitoringTools,
    };

    return new StateGraph(DiagnosisStateAnnotation)
      .addNode("classify_intent", classifyIntentNode)
      .addNode("extract_entities", extractEntitiesNode)
      .addNode("check_required_fields", checkRequiredFieldsNode)
      .addNode("ask_clarification", askClarificationNode)
      .addNode("retrieve_knowledge", createRetrieveKnowledgeNode(deps))
      .addNode("decide_tools", decideToolsNode)
      .addNode("query_monitoring", createQueryMonitoringNode(deps))
      .addNode("merge_evidence", mergeEvidenceNode)
      .addNode("generate_diagnosis", generateDiagnosisNode)
      .addNode("self_check", selfCheckNode)
      .addEdge(START, "classify_intent")
      .addEdge("classify_intent", "extract_entities")
      .addEdge("extract_entities", "check_required_fields")
      .addConditionalEdges("check_required_fields", routeAfterRequiredFields, {
        ask_clarification: "ask_clarification",
        retrieve_knowledge: "retrieve_knowledge",
      })
      .addEdge("ask_clarification", END)
      .addEdge("retrieve_knowledge", "decide_tools")
      .addConditionalEdges("decide_tools", routeAfterToolDecision, {
        query_monitoring: "query_monitoring",
        merge_evidence: "merge_evidence",
      })
      .addEdge("query_monitoring", "merge_evidence")
      .addEdge("merge_evidence", "generate_diagnosis")
      .addEdge("generate_diagnosis", "self_check")
      .addEdge("self_check", END)
      .compile();
  }
}

export const diagnosisService = new DiagnosisService();
