// DiagnosisMode — Frontend-First Escalation Diagnosis
//
// Three-phase flow:
//   Phase 1: Frontend Agent investigates → self-assesses need for escalation
//   Phase 2: Backend Agent investigates independently (only if escalated)
//   Phase 3: Leader scores both conclusions + synthesizes (only if escalated)
//
// Fast track: if frontend resolves alone, no backend/leader are invoked.
//
// Design doc: docs/design/diagnosis-mode-design.md

import type {
  TeamDefinition,
  TeamStreamEvent,
  AgentRole,
} from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import { AgentService } from "../../services/agent.js";
import type { CollaborationModeExecutor, ExecutionContext } from "./types.js";
import { toTeamEvent } from "./types.js";

// ---- Constants ----------------------------------------------------------

/** Backend error codes that trigger mandatory escalation */
export const BACKEND_ERROR_CODES = [
  "FACE_TIMEOUT",
  "FACE_FAILED",
  "LIVENESS_FAILED",
  "ALGORITHM_ERROR",
  "SERVER_ERROR",
  "INTERNAL_ERROR",
  "SERVICE_UNAVAILABLE",
  "GATEWAY_TIMEOUT",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "UPSTREAM_ERROR",
  "DB_ERROR",
  "CACHE_ERROR",
];

/** Regex patterns that indicate backend-dependent business stages */
export const BACKEND_STAGE_PATTERNS = [
  /活体(算法|检测|校验|比对)/,
  /liveness\s*(algorithm|detection|check|verify)/i,
  /服务端(校验|检测|比对)/,
  /人脸(比对|算法|识别)/,
  /face\s*(compare|match|verify|recognize)/i,
  /算法(超时|处理|排队)/,
  /algorithm\s*(timeout|processing|queue)/i,
];

/** Regex: the request reached backend and got an abnormal response */
const BACKEND_ABNORMAL_PATTERN =
  /(?:请求|request).*(?:到达|reached|返回|returned).*(?:后端|backend|server|服务端).*(?:异常|失败|错误|error|fail|timeout|超时)/i;

// ---- Internal Types -----------------------------------------------------

export interface FrontendOutput {
  conclusion: string;
  evidence: Array<{ type: string; detail: string }>;
  need_escalation: boolean;
  escalation_reason: string | null;
  context_for_backend: Record<string, unknown>;
}

export interface BackendOutput {
  conclusion: string;
  evidence: Array<{ type: string; detail: string }>;
}

export interface ScoringResult {
  frontend_score: number;
  backend_score: number;
  frontend_breakdown: Record<string, unknown>;
  backend_breakdown: Record<string, unknown>;
  reasoning: string;
  synthesis: string;
  missing_fields: string[];
  message: string;
}

interface AgentRunResult {
  events: TeamStreamEvent[];
  output: string | null;
}

// ---- DiagnosisMode ------------------------------------------------------

export class DiagnosisMode implements CollaborationModeExecutor {
  async *execute(
    definition: TeamDefinition,
    task: string,
    context: ExecutionContext,
  ): AsyncGenerator<TeamStreamEvent> {
    const bb = context.blackboard;
    const bus = context.bus;

    const frontendRole = definition.agents.find(
      (a) => a.name === "frontend_agent",
    );
    const backendRole = definition.agents.find(
      (a) => a.name === "backend_agent",
    );
    const leaderRole = definition.agents.find((a) => a.name === "leader");

    if (!frontendRole) {
      yield {
        type: "team_failed",
        error:
          "DiagnosisMode requires an agent named 'frontend_agent' in the team definition",
      };
      return;
    }

    bb.write("task", task, "system");

    yield {
      type: "team_started",
      teamRunId: context.teamRunId,
      teamName: definition.name,
      mode: "diagnosis",
      agents: definition.agents.map((a) => ({
        name: a.name,
        role: a.displayName,
      })),
    };

    // ═════════════════════════════════════════════════════════
    // Phase 1: Frontend Agent Investigation
    // ═════════════════════════════════════════════════════════

    const frontendResult = await this.runAgentAndCollect(
      frontendRole,
      this.buildFrontendTask(frontendRole, task, bb, bus),
      context,
    );
    for (const event of frontendResult.events) yield event;

    const frontendOutput = this.parseFrontendOutput(
      frontendResult.output || "",
    );

    // Safety net: rule-based check overrides LLM self-assessment
    if (this.checkRuleEscalation(frontendResult.output || "")) {
      if (!frontendOutput.need_escalation) {
        logger.info(
          { frontendConclusion: frontendOutput.conclusion?.slice(0, 200) },
          "DiagnosisMode: rule-based escalation triggered (LLM missed it)",
        );
        frontendOutput.need_escalation = true;
        frontendOutput.escalation_reason =
          "rule_override: backend error code or stage detected in frontend output";
      }
    }

    bb.write("frontend_conclusion", frontendOutput, "frontend_agent");

    // ---- Fast Track: Frontend Resolved Alone ----
    if (!frontendOutput.need_escalation) {
      yield {
        type: "team_completed",
        output: {
          conclusion: frontendOutput.conclusion,
          evidence: frontendOutput.evidence,
          resolution: "frontend_only",
          escalated: false,
        },
        totalDurationMs: 0,
        roundsCount: 1,
      };
      return;
    }

    // Store context for backend (facts only, not the conclusion)
    bb.write(
      "context_for_backend",
      frontendOutput.context_for_backend || {},
      "frontend_agent",
    );

    // ═════════════════════════════════════════════════════════
    // Phase 2: Backend Agent Independent Investigation
    // ═════════════════════════════════════════════════════════

    let backendOutput: BackendOutput;

    if (!backendRole) {
      logger.warn("DiagnosisMode: escalated but no backend_agent in team");
      backendOutput = {
        conclusion: "后端排查 Agent 未配置，无法执行独立排查。",
        evidence: [],
      };
    } else {
      const backendResult = await this.runAgentAndCollect(
        backendRole,
        this.buildBackendTask(
          backendRole,
          task,
          frontendOutput.context_for_backend,
          bb,
          bus,
        ),
        context,
      );
      for (const event of backendResult.events) yield event;

      backendOutput = this.parseBackendOutput(backendResult.output || "");
    }

    bb.write("backend_conclusion", backendOutput, "backend_agent");

    // ═════════════════════════════════════════════════════════
    // Phase 3: Leader Scoring & Synthesis
    // ═════════════════════════════════════════════════════════

    let scoringResult: ScoringResult;

    if (!leaderRole) {
      logger.warn("DiagnosisMode: escalated but no leader agent in team");
      scoringResult = buildFallbackScoring(
        frontendOutput,
        backendOutput,
        "团队未配置 leader Agent。",
      );
    } else {
      const leaderResult = await this.runAgentAndCollect(
        leaderRole,
        this.buildLeaderTask(
          leaderRole,
          task,
          frontendOutput,
          backendOutput,
          bb,
          bus,
        ),
        context,
      );
      for (const event of leaderResult.events) yield event;

      scoringResult = this.parseScoringOutput(leaderResult.output || "");
    }

    bb.write("scoring_result", scoringResult, "leader");

    const diagnosisResult = resolveDiagnosis(
      frontendOutput,
      backendOutput,
      scoringResult,
    );

    yield {
      type: "team_completed",
      output: {
        resolution: diagnosisResult.resolution,
        final_diagnosis: diagnosisResult.finalDiagnosis,
        scoring: scoringResult,
        escalated: true,
      },
      totalDurationMs: 0,
      roundsCount: 3,
    };
  }

  // ═════════════════════════════════════════════════════════
  // Agent Runner (collects events + captures output)
  // ═════════════════════════════════════════════════════════

  private async runAgentAndCollect(
    role: AgentRole,
    taskPrompt: string,
    context: ExecutionContext,
  ): Promise<AgentRunResult> {
    const events: TeamStreamEvent[] = [];
    let output: string | null = null;

    events.push({
      type: "agent_started",
      agentName: role.name,
      role: role.displayName,
      task: taskPrompt,
    });

    const agentService = new AgentService();

    try {
      for await (const event of agentService.run(
        context.conversationId,
        taskPrompt,
        {
          maxIterations: role.maxIterations,
          tools: role.tools.length > 0 ? role.tools : null,
          scope: context.scope,
        },
      )) {
        const teamEvent = toTeamEvent(event, role.name);
        if (teamEvent) events.push(teamEvent);
        if (event.type === "agent_respond") {
          output = event.content || event.summary || null;
        }
      }

      events.push({
        type: "agent_completed",
        agentName: role.name,
        output: output || "",
        durationMs: 0,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Agent failed";
      logger.error(
        { agentName: role.name, error: errorMsg },
        "DiagnosisMode: agent execution failed",
      );
      events.push({
        type: "agent_error",
        agentName: role.name,
        error: errorMsg,
      });
    }

    return { events, output };
  }

  // ═════════════════════════════════════════════════════════
  // Task Builders
  // ═════════════════════════════════════════════════════════

  private buildFrontendTask(
    role: AgentRole,
    task: string,
    bb: ExecutionContext["blackboard"],
    _bus: ExecutionContext["bus"],
  ): string {
    return [
      role.systemPrompt,
      "",
      "## 当前任务",
      task,
      "",
      "## Blackboard（共享上下文）",
      bb.toContextString(),
      "",
      "## 输出要求",
      "你必须以 JSON 格式输出你的排查结论：",
      "",
      "```json",
      "{",
      '  "conclusion": "排查结论——用户业务流程走到了哪一步、在哪个阶段中断、前端捕获到了什么",',
      '  "evidence": [',
      '    { "type": "log|trace|observation|knowledge", "detail": "具体证据" }',
      "  ],",
      '  "need_escalation": true或false,',
      '  "escalation_reason": "monitoring_indicates_backend|cannot_determine|null（不需要升级时）",',
      '  "context_for_backend": {',
      '    "traceId": "从上下文提取的 traceId",',
      '    "failedStage": "失败发生的业务阶段",',
      '    "clientType": "H5/小程序/App/Web",',
      '    "timestamp": "失败发生时间",',
      '    "frontendObservation": "前端观察到的现象（只写事实，不包含判断结论）"',
      "  }",
      "}",
      "```",
      "",
      "注意：请输出纯 JSON，不要带额外的解释文字或 markdown 代码块标记。",
    ].join("\n");
  }

  private buildBackendTask(
    role: AgentRole,
    task: string,
    contextForBackend: unknown,
    bb: ExecutionContext["blackboard"],
    _bus: ExecutionContext["bus"],
  ): string {
    const ctxLines =
      typeof contextForBackend === "object" && contextForBackend !== null
        ? Object.entries(contextForBackend as Record<string, unknown>)
            .map(([k, v]) => `- ${k}: ${v}`)
            .join("\n")
        : "无";

    return [
      role.systemPrompt,
      "",
      "## 原始用户问题",
      task,
      "",
      "## 前端排查上下文（仅包含事实数据，不包含前端结论）",
      ctxLines,
      "",
      "## Blackboard（共享上下文）",
      bb.toContextString(),
      "",
      "## 重要提示",
      '- 以上「前端排查上下文」只包含事实数据，不包含前端 Agent 的判断结论。',
      "- 你必须独立形成判断，不能假设前端结论正确或错误。",
      "- 基于后端监控数据、trace 链路、错误码分布，从服务端视角定位根因。",
      "",
      "## 输出要求",
      "你必须以 JSON 格式输出排查结论：",
      "",
      "```json",
      "{",
      '  "conclusion": "独立排查结论——包含根因定位、关键指标、时间线",',
      '  "evidence": [',
      '    { "type": "trace|metric|distribution|knowledge", "detail": "具体证据" }',
      "  ]",
      "}",
      "```",
      "",
      "注意：请输出纯 JSON，不要带额外的解释文字或 markdown 代码块标记。",
    ].join("\n");
  }

  private buildLeaderTask(
    role: AgentRole,
    task: string,
    frontendResult: FrontendOutput,
    backendResult: BackendOutput,
    bb: ExecutionContext["blackboard"],
    _bus: ExecutionContext["bus"],
  ): string {
    const frontendJson = JSON.stringify(frontendResult, null, 2);
    const backendJson = JSON.stringify(backendResult, null, 2);

    return [
      role.systemPrompt,
      "",
      "## 原始用户问题",
      task,
      "",
      "## 前端 Agent 结论",
      "```json",
      frontendJson,
      "```",
      "",
      "## 后端 Agent 结论",
      "```json",
      backendJson,
      "```",
      "",
      "## 评分标准（四维度，满分 9 分）",
      "",
      "请对以上两条结论分别按以下四个维度打分：",
      "",
      "| 维度 | 分值 | 评分标准 |",
      "|------|------|----------|",
      "| 证据等级 | 0-3 | 3=有监控指标/日志/trace数据支撑；2=有知识库文档引用；1=纯推理/经验判断；0=纯猜测 |",
      "| 可验证性 | 0-3 | 3=含具体数字（延迟、错误码、时间戳）；1=方向性判断；0=无法验证 |",
      "| 覆盖度 | -1~2 | 2=解释了所有症状；1=部分解释；-1=与某些症状矛盾 |",
      "| 领域权威 | 0-1 | 1=结论在该角色擅长领域内（后端关于延迟=后端Agent+1，前端关于浏览器行为=前端Agent+1）；0=不在 |",
      "",
      "## Blackboard（共享上下文）",
      bb.toContextString(),
      "",
      "## 输出要求",
      "以 JSON 格式输出评分结果：",
      "",
      "```json",
      "{",
      '  "frontend_score": 前端总分(0-9),',
      '  "backend_score": 后端总分(0-9),',
      '  "frontend_breakdown": {',
      '    "evidence_quality": 0-3,',
      '    "verifiability": 0-3,',
      '    "coverage": -1到2,',
      '    "domain_authority": 0-1',
      "  },",
      '  "backend_breakdown": {',
      '    "evidence_quality": 0-3,',
      '    "verifiability": 0-3,',
      '    "coverage": -1到2,',
      '    "domain_authority": 0-1',
      "  },",
      '  "reasoning": "评分理由，逐维度说明为什么给这个分数",',
      '  "synthesis": "综合诊断结论——以证据更强的结论为主线，标注分叉点",',
      '  "missing_fields": ["需要补充的信息字段（不需要转人工时为空数组）"],',
      '  "message": "转人工时的提示消息（不需要转人工时为空字符串）"',
      "}",
      "```",
      "",
      "注意：请输出纯 JSON，不要带额外的解释文字或 markdown 代码块标记。",
    ].join("\n");
  }

  // ═════════════════════════════════════════════════════════
  // Output Parsers (delegate to exported functions)
  // ═════════════════════════════════════════════════════════

  private parseFrontendOutput(output: string): FrontendOutput {
    return parseFrontendOutput(output);
  }

  private parseBackendOutput(output: string): BackendOutput {
    return parseBackendOutput(output);
  }

  private parseScoringOutput(output: string): ScoringResult {
    return parseScoringOutput(output);
  }

  // ═════════════════════════════════════════════════════════
  // Rule-Based Escalation (delegate to exported function)
  // ═════════════════════════════════════════════════════════

  private checkRuleEscalation(frontendOutput: string): boolean {
    return checkRuleEscalation(frontendOutput);
  }
}

// ═════════════════════════════════════════════════════════════
// Exported Pure Functions (testable without AgentService)
// ═════════════════════════════════════════════════════════════

/**
 * Scan agent output for backend error codes and backend-dependent
 * business stages. Safety net — even if LLM says no escalation,
 * we escalate if backend indicators are detected.
 */
export function checkRuleEscalation(frontendOutput: string): boolean {
  const upper = frontendOutput.toUpperCase();

  for (const code of BACKEND_ERROR_CODES) {
    if (upper.includes(code)) {
      return true;
    }
  }

  for (const pattern of BACKEND_STAGE_PATTERNS) {
    if (pattern.test(frontendOutput)) {
      return true;
    }
  }

  if (BACKEND_ABNORMAL_PATTERN.test(frontendOutput)) {
    return true;
  }

  return false;
}

/**
 * Extract a JSON object from LLM text output.
 * Tries fenced code blocks first, then raw JSON.
 */
export function extractJSON(text: string): Record<string, unknown> {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    return JSON.parse(fence[1].trim()) as Record<string, unknown>;
  }

  const raw = text.match(/\{[\s\S]*\}/);
  if (raw) {
    return JSON.parse(raw[0]) as Record<string, unknown>;
  }

  throw new Error("No JSON found in output");
}

/** Parse frontend agent output into structured form, with fallback on failure */
export function parseFrontendOutput(output: string): FrontendOutput {
  try {
    const json = extractJSON(output);
    return {
      conclusion: String(json.conclusion || ""),
      evidence: Array.isArray(json.evidence) ? json.evidence : [],
      need_escalation: Boolean(json.need_escalation),
      escalation_reason:
        typeof json.escalation_reason === "string"
          ? json.escalation_reason
          : null,
      context_for_backend:
        typeof json.context_for_backend === "object" &&
        json.context_for_backend !== null
          ? (json.context_for_backend as Record<string, unknown>)
          : {},
    };
  } catch {
    return {
      conclusion: output.slice(0, 500),
      evidence: [],
      need_escalation: false,
      escalation_reason: null,
      context_for_backend: {},
    };
  }
}

/** Parse backend agent output into structured form, with fallback on failure */
export function parseBackendOutput(output: string): BackendOutput {
  try {
    const json = extractJSON(output);
    return {
      conclusion: String(json.conclusion || ""),
      evidence: Array.isArray(json.evidence) ? json.evidence : [],
    };
  } catch {
    return {
      conclusion: output.slice(0, 500),
      evidence: [],
    };
  }
}

/** Parse leader scoring output into structured form, with fallback on failure */
export function parseScoringOutput(output: string): ScoringResult {
  try {
    const json = extractJSON(output);
    return {
      frontend_score:
        typeof json.frontend_score === "number" ? json.frontend_score : 0,
      backend_score:
        typeof json.backend_score === "number" ? json.backend_score : 0,
      frontend_breakdown:
        typeof json.frontend_breakdown === "object" &&
        json.frontend_breakdown !== null
          ? (json.frontend_breakdown as Record<string, unknown>)
          : {},
      backend_breakdown:
        typeof json.backend_breakdown === "object" &&
        json.backend_breakdown !== null
          ? (json.backend_breakdown as Record<string, unknown>)
          : {},
      reasoning: String(json.reasoning || ""),
      synthesis: String(json.synthesis || ""),
      missing_fields: Array.isArray(json.missing_fields)
        ? json.missing_fields.map(String)
        : [],
      message: String(json.message || ""),
    };
  } catch {
    return buildFallbackScoring(
      {
        conclusion: output,
        evidence: [],
        need_escalation: true,
        escalation_reason: null,
        context_for_backend: {},
      },
      { conclusion: "", evidence: [] },
    );
  }
}

/** Build a fallback (zero-score, needs-human) scoring result */
export function buildFallbackScoring(
  frontend: FrontendOutput,
  backend: BackendOutput,
  reason?: string,
): ScoringResult {
  return {
    frontend_score: 0,
    backend_score: 0,
    frontend_breakdown: {
      evidence_quality: 0,
      verifiability: 0,
      coverage: 0,
      domain_authority: 0,
    },
    backend_breakdown: {
      evidence_quality: 0,
      verifiability: 0,
      coverage: 0,
      domain_authority: 0,
    },
    reasoning: reason ?? "Leader 未产出有效评分。",
    synthesis: [
      `前端结论：${frontend.conclusion}`,
      `后端结论：${backend.conclusion}`,
    ].join("\n"),
    missing_fields: ["traceId", "具体失败时间"],
    message: "自动评分未产出有效结果，已转人工处理。",
  };
}

/** Resolution outcome from scoring two agent conclusions */
export interface DiagnosisResolution {
  resolution: "adopt_frontend" | "adopt_backend" | "divergent" | "needs_human";
  finalDiagnosis: Record<string, unknown>;
}

/**
 * Apply the scoring thresholds to determine the final resolution.
 * Pure function — no side effects, fully testable.
 */
export function resolveDiagnosis(
  frontend: FrontendOutput,
  backend: BackendOutput,
  scoring: ScoringResult,
): DiagnosisResolution {
  const { frontend_score: fScore, backend_score: bScore } = scoring;
  const scoreDiff = Math.abs(fScore - bScore);
  const maxScore = Math.max(fScore, bScore);

  if (maxScore < 3) {
    return {
      resolution: "needs_human",
      finalDiagnosis: {
        status: "needs_human",
        collected_info: {
          frontend_finding: frontend.conclusion,
          backend_finding: backend.conclusion,
        },
        missing_fields: scoring.missing_fields,
        message:
          scoring.message ||
          "当前信息不足以自动定位根因，已转人工处理。",
      },
    };
  }

  if (scoreDiff >= 3) {
    const winner = fScore > bScore ? "frontend" : "backend";
    const winnerResult = winner === "frontend" ? frontend : (backend as unknown as FrontendOutput);
    const loserResult = winner === "frontend" ? (backend as unknown as FrontendOutput) : frontend;
    return {
      resolution: winner === "frontend" ? "adopt_frontend" : "adopt_backend",
      finalDiagnosis: {
        conclusion: winnerResult.conclusion,
        evidence: winnerResult.evidence,
        dissenting_view: {
          agent: winner === "frontend" ? "backend_agent" : "frontend_agent",
          conclusion: loserResult.conclusion,
          note: "已排查，证据不支撑此结论。",
          score: winner === "frontend" ? bScore : fScore,
        },
        scoring,
      },
    };
  }

  return {
    resolution: "divergent",
    finalDiagnosis: {
      frontend_view: {
        conclusion: frontend.conclusion,
        score: fScore,
        evidence: frontend.evidence,
      },
      backend_view: {
        conclusion: backend.conclusion,
        score: bScore,
        evidence: backend.evidence,
      },
      scoring,
    },
  };
}
