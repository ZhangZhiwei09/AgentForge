// DiagnosisMode — Unit & Integration Tests
//
// Covers:
//   1. Pure functions: extractJSON, checkRuleEscalation, parse*, resolveDiagnosis
//   2. End-to-end flow with mocked AgentService (no LLM required)
//
// Run: pnpm --filter @agentforge/server test -- --run src/teams/modes/__tests__/diagnosis.test.ts

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  DiagnosisMode,
  extractJSON,
  checkRuleEscalation,
  parseFrontendOutput,
  parseBackendOutput,
  parseScoringOutput,
  buildFallbackScoring,
  resolveDiagnosis,
  BACKEND_ERROR_CODES,
  type FrontendOutput,
  type BackendOutput,
  type ScoringResult,
} from "../diagnosis.js";
import type { TeamDefinition, TeamStreamEvent } from "@agentforge/shared-types";
import { Blackboard } from "../../blackboard.js";
import { MessageBus } from "../../message-bus.js";
import type { ExecutionContext } from "../types.js";

// ═══════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════

/** A complete frontend output with escalation (backend error found) */
const FRONTEND_WITH_ESCALATION: FrontendOutput = {
  conclusion:
    "用户进入了活体采集阶段，3 秒后连接断开。WebSocket 在活体采集阶段断开，断开码 1006。",
  evidence: [
    {
      type: "log",
      detail: "getUserMedia success, 摄像头权限已授权",
    },
    {
      type: "trace",
      detail: "业务流程走到了 liveness_capture 阶段，发现 FACE_TIMEOUT",
    },
    {
      type: "observation",
      detail: "WebSocket 在活体采集开始 3 秒后断开，断开码 1006",
    },
  ],
  need_escalation: true,
  escalation_reason: "monitoring_indicates_backend",
  context_for_backend: {
    traceId: "abc123",
    failedStage: "liveness_capture",
    clientType: "H5",
    timestamp: "2026-07-05T14:30:00+08:00",
    frontendObservation:
      "摄像头权限正常，WebSocket 在活体采集阶段异常断开",
  },
};

/** A frontend output where the issue can be resolved without backend */
const FRONTEND_NO_ESCALATION: FrontendOutput = {
  conclusion:
    "用户 H5 摄像头无法打开，浏览器提示 NotAllowedError。原因是用户拒绝了摄像头权限请求，且在 HTTP 环境下不支持 getUserMedia。",
  evidence: [
    { type: "log", detail: "getUserMedia 返回 NotAllowedError" },
    {
      type: "knowledge",
      detail: "H5 摄像头需要 HTTPS 环境且用户需授予权限",
    },
  ],
  need_escalation: false,
  escalation_reason: null,
  context_for_backend: {},
};

/** A strong backend conclusion with specific metrics */
const BACKEND_STRONG: BackendOutput = {
  conclusion:
    "活体算法处理耗时 2.8s，超过阈值 2.5s，服务端返回 FACE_TIMEOUT。P99 延迟 4.2s，其中网络传输占用 1.2s，算法处理占用 2.8s。根因是算法处理超时。",
  evidence: [
    {
      type: "trace",
      detail:
        "traceId abc123, 服务端接收 14:30:01, 返回 FACE_TIMEOUT 14:30:04",
    },
    {
      type: "metric",
      detail: "P99 liveness_algorithm_duration = 2.8s, 阈值 = 2.5s",
    },
    {
      type: "distribution",
      detail: "FACE_TIMEOUT 占该商户今日失败量的 42%",
    },
  ],
};

/** A weak backend conclusion with no hard data */
const BACKEND_WEAK: BackendOutput = {
  conclusion: "后端监控未发现明显异常，疑似前端问题。",
  evidence: [
    {
      type: "observation",
      detail: "服务端各接口耗时和错误率均在正常范围",
    },
  ],
};

/** A strong scoring result (backend wins clearly) */
const SCORING_BACKEND_WINS: ScoringResult = {
  frontend_score: 4,
  backend_score: 9,
  frontend_breakdown: {
    evidence_quality: 1,
    verifiability: 1,
    coverage: 1,
    domain_authority: 1,
  },
  backend_breakdown: {
    evidence_quality: 3,
    verifiability: 3,
    coverage: 2,
    domain_authority: 1,
  },
  reasoning:
    "后端结论有具体 trace 指标和错误码数据支撑，可验证性强，完整解释了失败原因和前端现象。",
  synthesis:
    "根因是活体算法处理超时（2.8s > 2.5s 阈值），服务端返回 FACE_TIMEOUT 后主动关闭连接，前端因此看到 WebSocket 断开。",
  missing_fields: [],
  message: "",
};

/** Scoring where both agents have weak evidence */
const SCORING_BOTH_WEAK: ScoringResult = {
  frontend_score: 2,
  backend_score: 1,
  frontend_breakdown: {
    evidence_quality: 1,
    verifiability: 1,
    coverage: 0,
    domain_authority: 0,
  },
  backend_breakdown: {
    evidence_quality: 0,
    verifiability: 0,
    coverage: 0,
    domain_authority: 1,
  },
  reasoning: "双方都缺乏具体数据支撑。",
  synthesis: "无法定位根因。",
  missing_fields: ["traceId", "具体失败时间", "用户设备型号"],
  message: "当前信息不足以自动定位根因，已转人工处理。建议补充 traceId 和具体失败时间后重新排查。",
};

/** Scoring where both are close (within 3 points) */
const SCORING_DIVERGENT: ScoringResult = {
  frontend_score: 6,
  backend_score: 5,
  frontend_breakdown: {
    evidence_quality: 2,
    verifiability: 2,
    coverage: 1,
    domain_authority: 1,
  },
  backend_breakdown: {
    evidence_quality: 2,
    verifiability: 1,
    coverage: 1,
    domain_authority: 1,
  },
  reasoning: "双方都有一定证据，但侧重点不同。前端侧重用户体验流程分析，后端侧重指标统计。",
  synthesis: "前端和后端排查结论各有依据，建议综合参考。",
  missing_fields: [],
  message: "",
};

/** Build a minimal team definition for diagnosis mode */
function makeTeamDefinition(overrides?: Partial<TeamDefinition>): TeamDefinition {
  return {
    name: "诊断测试团队",
    version: "1.0",
    collaborationMode: "diagnosis",
    agents: [
      {
        name: "frontend_agent",
        displayName: "前端排查专家",
        description: "前端排查",
        systemPrompt: "你是前端排查专家。",
        tools: ["query_trace_log"],
        maxIterations: 3,
        priority: 10,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "backend_agent",
        displayName: "后端排查专家",
        description: "后端排查",
        systemPrompt: "你是后端排查专家。",
        tools: ["query_trace_log", "search_knowledge_base"],
        maxIterations: 3,
        priority: 8,
        canDelegate: false,
        canBroadcast: false,
      },
      {
        name: "leader",
        displayName: "诊断汇总",
        description: "评分汇总",
        systemPrompt: "你是诊断汇总专家。",
        tools: [],
        maxIterations: 2,
        priority: 5,
        canDelegate: false,
        canBroadcast: false,
      },
    ],
    maxTotalIterations: 3,
    ...overrides,
  };
}

/** Build minimal ExecutionContext for testing */
function makeContext(
  overrides?: Partial<ExecutionContext>,
): ExecutionContext {
  const teamRunId = overrides?.teamRunId ?? "test-run-1";
  return {
    teamRunId,
    conversationId: "test-conv-1",
    userId: "test-user",
    definition: makeTeamDefinition(),
    bus: new MessageBus(teamRunId),
    blackboard: new Blackboard(),
    variables: {},
    ...overrides,
  };
}

/** Collect all events from a DiagnosisMode execution */
async function collectEvents(
  mode: DiagnosisMode,
  definition: TeamDefinition,
  task: string,
  context: ExecutionContext,
): Promise<TeamStreamEvent[]> {
  const events: TeamStreamEvent[] = [];
  for await (const event of mode.execute(definition, task, context)) {
    events.push(event);
  }
  return events;
}

// ═══════════════════════════════════════════════════════════
// Section 1: extractJSON
// ═══════════════════════════════════════════════════════════

describe("extractJSON", () => {
  it("extracts JSON from fenced code block with json tag", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(extractJSON(input)).toEqual({ key: "value" });
  });

  it("extracts JSON from fenced code block without json tag", () => {
    const input = '```\n{"key": "value"}\n```';
    expect(extractJSON(input)).toEqual({ key: "value" });
  });

  it("extracts raw JSON when no code fence present", () => {
    const input = 'Some text before {"key": "value"} some text after';
    expect(extractJSON(input)).toEqual({ key: "value" });
  });

  it("extracts nested JSON objects", () => {
    const input =
      '{"conclusion": "test", "evidence": [{"type": "log", "detail": "x"}]}';
    const result = extractJSON(input);
    expect(result.conclusion).toBe("test");
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(result.evidence).toHaveLength(1);
  });

  it("throws when no JSON found", () => {
    expect(() => extractJSON("just plain text, no braces")).toThrow(
      "No JSON found in output",
    );
  });

  it("throws on malformed JSON", () => {
    expect(() => extractJSON("{bad json}")).toThrow();
  });

  it("throws when greedy regex captures multiple JSON objects as one", () => {
    // Greedy /\{[\s\S]*\}/ matches from first { to last }, capturing
    // interleaving text. This is a known limitation — LLM outputs should
    // contain a single JSON object.
    const input = '{"first": 1} some text {"second": 2}';
    expect(() => extractJSON(input)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// Section 2: checkRuleEscalation
// ═══════════════════════════════════════════════════════════

describe("checkRuleEscalation", () => {
  it("returns true for FACE_TIMEOUT in output", () => {
    expect(
      checkRuleEscalation(
        "用户活体采集阶段返回错误码 FACE_TIMEOUT，疑似服务端超时",
      ),
    ).toBe(true);
  });

  it("returns true for ACE_TIMEOUT in the original task", () => {
    expect(checkRuleEscalation("ACE_TIMEOUT 错误怎么排查")).toBe(true);
  });

  it("returns true for SERVER_ERROR in output (case insensitive)", () => {
    expect(
      checkRuleEscalation("后端返回 server_error 异常"),
    ).toBe(true);
  });

  it("returns true for each BACKEND_ERROR_CODE", () => {
    for (const code of BACKEND_ERROR_CODES) {
      expect(checkRuleEscalation(`发现错误码 ${code} 需要后端排查`)).toBe(
        true,
      );
    }
  });

  it("returns true for backend stage patterns", () => {
    const cases = [
      "用户进入了活体算法阶段",
      "活体检测时连接断开",
      "服务端校验失败",
      "人脸比对超时",
      "算法处理耗时过长",
      "Liveness detection timeout",
      "Face compare failed at server side",
    ];
    for (const c of cases) {
      expect(checkRuleEscalation(c)).toBe(true);
    }
  });

  it("returns true when request reached backend and returned abnormal", () => {
    expect(
      checkRuleEscalation(
        "用户请求已到达后端服务，但返回了异常状态码 500",
      ),
    ).toBe(true);
  });

  it("returns false for frontend-only issues", () => {
    expect(
      checkRuleEscalation(
        "浏览器摄像头权限被拒绝，用户需在 Chrome 设置中允许摄像头权限",
      ),
    ).toBe(false);
  });

  it("returns false for SDK configuration issues", () => {
    expect(
      checkRuleEscalation(
        "SDK 初始化失败，需检查 appId 和 secret 配置是否正确",
      ),
    ).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(checkRuleEscalation("")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// Section 3: parseFrontendOutput
// ═══════════════════════════════════════════════════════════

describe("parseFrontendOutput", () => {
  it("parses valid frontend JSON with escalation", () => {
    const json = JSON.stringify(FRONTEND_WITH_ESCALATION);
    const result = parseFrontendOutput(json);
    expect(result.conclusion).toContain("活体采集");
    expect(result.evidence).toHaveLength(3);
    expect(result.need_escalation).toBe(true);
    expect(result.escalation_reason).toBe("monitoring_indicates_backend");
    expect(result.context_for_backend.traceId).toBe("abc123");
  });

  it("parses valid frontend JSON without escalation", () => {
    const json = JSON.stringify(FRONTEND_NO_ESCALATION);
    const result = parseFrontendOutput(json);
    expect(result.need_escalation).toBe(false);
    expect(result.escalation_reason).toBeNull();
  });

  it("falls back to raw text when JSON parse fails", () => {
    const result = parseFrontendOutput("摄像头权限被拒绝，需要 HTTPS");
    expect(result.conclusion).toBe("摄像头权限被拒绝，需要 HTTPS");
    expect(result.evidence).toEqual([]);
    expect(result.need_escalation).toBe(false);
    expect(result.context_for_backend).toEqual({});
  });

  it("handles missing fields with defaults", () => {
    const result = parseFrontendOutput('{"conclusion": "test"}');
    expect(result.conclusion).toBe("test");
    expect(result.evidence).toEqual([]);
    expect(result.need_escalation).toBe(false);
  });

  it("does not allow an empty conclusion to enter fast track", () => {
    const result = parseFrontendOutput(
      '{"conclusion": "", "evidence": [], "need_escalation": false}',
    );
    expect(result.conclusion).toContain("未提供可验证结论");
    expect(result.need_escalation).toBe(true);
    expect(result.escalation_reason).toBe("cannot_determine");
  });

  it("handles null escalation_reason", () => {
    const result = parseFrontendOutput(
      '{"conclusion": "x", "evidence": [], "need_escalation": false, "escalation_reason": null, "context_for_backend": {}}',
    );
    expect(result.escalation_reason).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// Section 4: parseBackendOutput
// ═══════════════════════════════════════════════════════════

describe("parseBackendOutput", () => {
  it("parses valid backend JSON", () => {
    const json = JSON.stringify(BACKEND_STRONG);
    const result = parseBackendOutput(json);
    expect(result.conclusion).toContain("活体算法处理");
    expect(result.evidence).toHaveLength(3);
  });

  it("falls back to raw text on parse failure", () => {
    const result = parseBackendOutput("后端监控一切正常");
    expect(result.conclusion).toBe("后端监控一切正常");
    expect(result.evidence).toEqual([]);
  });

  it("does not render an empty backend conclusion", () => {
    const result = parseBackendOutput('{"conclusion": "", "evidence": []}');
    expect(result.conclusion).toContain("未提供可验证结论");
  });

  it("truncates long fallback to 500 chars", () => {
    const long = "x".repeat(600);
    const result = parseBackendOutput(long);
    expect(result.conclusion.length).toBe(500);
  });
});

// ═══════════════════════════════════════════════════════════
// Section 5: parseScoringOutput
// ═══════════════════════════════════════════════════════════

describe("parseScoringOutput", () => {
  it("parses valid scoring JSON", () => {
    const json = JSON.stringify(SCORING_BACKEND_WINS);
    const result = parseScoringOutput(json);
    expect(result.frontend_score).toBe(4);
    expect(result.backend_score).toBe(9);
    expect(result.frontend_breakdown.evidence_quality).toBe(1);
    expect(result.backend_breakdown.evidence_quality).toBe(3);
    expect(result.synthesis).toContain("根因");
  });

  it("returns fallback on parse failure", () => {
    const result = parseScoringOutput("not valid json at all");
    expect(result.frontend_score).toBe(0);
    expect(result.backend_score).toBe(0);
    expect(result.message).toContain("转人工");
    expect(result.missing_fields).toContain("traceId");
  });
});

// ═══════════════════════════════════════════════════════════
// Section 6: buildFallbackScoring
// ═══════════════════════════════════════════════════════════

describe("buildFallbackScoring", () => {
  it("returns zero scores with default reason when none provided", () => {
    const result = buildFallbackScoring(
      FRONTEND_WITH_ESCALATION,
      BACKEND_STRONG,
    );
    expect(result.frontend_score).toBe(0);
    expect(result.backend_score).toBe(0);
    expect(result.message).toContain("转人工");
  });

  it("includes custom reason when provided", () => {
    const result = buildFallbackScoring(
      FRONTEND_WITH_ESCALATION,
      BACKEND_STRONG,
      "custom reason text",
    );
    expect(result.reasoning).toBe("custom reason text");
  });
});

// ═══════════════════════════════════════════════════════════
// Section 7: resolveDiagnosis — Scoring Thresholds
// ═══════════════════════════════════════════════════════════

describe("resolveDiagnosis", () => {
  it("adopts backend when score diff >= 3", () => {
    const result = resolveDiagnosis(
      FRONTEND_WITH_ESCALATION,
      BACKEND_STRONG,
      SCORING_BACKEND_WINS, // fScore=4, bScore=9, diff=5
    );
    expect(result.resolution).toBe("adopt_backend");
    const diag = result.finalDiagnosis as Record<string, unknown>;
    expect(diag.conclusion).toContain("活体算法处理");
    expect(diag.dissenting_view).toBeDefined();
  });

  it("adopts frontend when frontend score is significantly higher", () => {
    const scoring: ScoringResult = {
      ...SCORING_BACKEND_WINS,
      frontend_score: 8,
      backend_score: 3,
    };
    const result = resolveDiagnosis(
      FRONTEND_WITH_ESCALATION,
      BACKEND_WEAK,
      scoring,
    );
    expect(result.resolution).toBe("adopt_frontend");
  });

  it("returns divergent when score diff < 3 and both scores >= 3", () => {
    const result = resolveDiagnosis(
      FRONTEND_WITH_ESCALATION,
      BACKEND_STRONG,
      SCORING_DIVERGENT, // fScore=6, bScore=5, diff=1
    );
    expect(result.resolution).toBe("divergent");
    const diag = result.finalDiagnosis as Record<string, unknown>;
    expect(diag.frontend_view).toBeDefined();
    expect(diag.backend_view).toBeDefined();
  });

  it("returns needs_human when both scores < 3", () => {
    const result = resolveDiagnosis(
      FRONTEND_WITH_ESCALATION,
      BACKEND_WEAK,
      SCORING_BOTH_WEAK, // fScore=2, bScore=1, max=2 < 3
    );
    expect(result.resolution).toBe("needs_human");
    const diag = result.finalDiagnosis as Record<string, unknown>;
    expect(diag.status).toBe("needs_human");
    expect(diag.missing_fields).toEqual(SCORING_BOTH_WEAK.missing_fields);
  });

  it("returns needs_human when one score is 3+ but the other drags max down", () => {
    const scoring: ScoringResult = {
      ...SCORING_BOTH_WEAK,
      frontend_score: 2,
      backend_score: 2,
    };
    const result = resolveDiagnosis(
      FRONTEND_WITH_ESCALATION,
      BACKEND_WEAK,
      scoring,
    );
    expect(result.resolution).toBe("needs_human");
  });

  it("returns adopt_backend at exact threshold diff=3", () => {
    const scoring: ScoringResult = {
      ...SCORING_BACKEND_WINS,
      frontend_score: 4,
      backend_score: 7,
    };
    const result = resolveDiagnosis(
      FRONTEND_WITH_ESCALATION,
      BACKEND_STRONG,
      scoring,
    );
    expect(result.resolution).toBe("adopt_backend");
  });

  it("returns divergent at exact threshold diff=2", () => {
    const scoring: ScoringResult = {
      ...SCORING_BACKEND_WINS,
      frontend_score: 5,
      backend_score: 7,
    };
    const result = resolveDiagnosis(
      FRONTEND_WITH_ESCALATION,
      BACKEND_STRONG,
      scoring,
    );
    expect(result.resolution).toBe("divergent");
  });
});

// ═══════════════════════════════════════════════════════════
// Section 8: Integration — DiagnosisMode.execute (mocked AgentService)
// ═══════════════════════════════════════════════════════════

// Mock AgentService at module level — all tests in this describe block
// use controlled agent responses instead of real LLM calls.
const mockAgentRun = vi.fn();

vi.mock("../../../services/agent.js", () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    run: mockAgentRun,
  })),
}));

describe("DiagnosisMode integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeAgentRespond(content: string) {
    return (async function* () {
      yield { type: "agent_respond", content };
    })();
  }

  it("fast track: frontend resolves alone, no backend or leader invoked", async () => {
    mockAgentRun.mockReturnValue(
      makeAgentRespond(JSON.stringify(FRONTEND_NO_ESCALATION)),
    );

    const mode = new DiagnosisMode();
    const context = makeContext();
    const events = await collectEvents(
      mode,
      context.definition,
      "H5 摄像头打不开怎么办",
      context,
    );

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("team_started");
    expect(eventTypes).toContain("agent_started");
    expect(eventTypes).toContain("agent_completed");
    expect(eventTypes).toContain("team_completed");

    const completed = events.find((e) => e.type === "team_completed");
    expect(completed).toBeDefined();
    const output = (completed as { output: Record<string, unknown> }).output;
    expect(output.resolution).toBe("frontend_only");
    expect(output.escalated).toBe(false);

    // Only frontend agent should have been invoked
    expect(mockAgentRun).toHaveBeenCalledTimes(1);
  });

  it("escalation path: frontend escalates → backend + leader invoked", async () => {
    // Sequence: frontend (escalation), backend (strong), leader (scores)
    mockAgentRun
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(FRONTEND_WITH_ESCALATION)),
      )
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(BACKEND_STRONG)),
      )
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(SCORING_BACKEND_WINS)),
      );

    const mode = new DiagnosisMode();
    const context = makeContext();
    const events = await collectEvents(
      mode,
      context.definition,
      "traceId abc123 用户刷脸失败",
      context,
    );

    // Should have 3 agents: frontend, backend, leader
    const startedAgents = events
      .filter((e) => e.type === "agent_started")
      .map((e) => (e as { agentName: string }).agentName);
    expect(startedAgents).toEqual([
      "frontend_agent",
      "backend_agent",
      "leader",
    ]);

    const completed = events.find((e) => e.type === "team_completed");
    const output = (completed as { output: Record<string, unknown> }).output;
    expect(output.resolution).toBe("adopt_backend");
    expect(output.escalated).toBe(true);
    expect(mockAgentRun).toHaveBeenCalledTimes(3);
  });

  it("needs_human: both agents produce weak conclusions", async () => {
    const weakFrontend = JSON.stringify({
      conclusion: "前端未发现明显异常",
      evidence: [],
      need_escalation: true,
      escalation_reason: "cannot_determine",
      context_for_backend: { traceId: "xyz" },
    });

    mockAgentRun
      .mockReturnValueOnce(makeAgentRespond(weakFrontend))
      .mockReturnValueOnce(makeAgentRespond(JSON.stringify(BACKEND_WEAK)))
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(SCORING_BOTH_WEAK)),
      );

    const mode = new DiagnosisMode();
    const context = makeContext();
    const events = await collectEvents(
      mode,
      context.definition,
      "用户反馈刷脸失败但不清楚具体错误",
      context,
    );

    const completed = events.find((e) => e.type === "team_completed");
    const output = (completed as { output: Record<string, unknown> }).output;
    expect(output.resolution).toBe("needs_human");
  });

  it("divergent: both agents have close scores", async () => {
    mockAgentRun
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(FRONTEND_WITH_ESCALATION)),
      )
      .mockReturnValueOnce(makeAgentRespond(JSON.stringify(BACKEND_STRONG)))
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(SCORING_DIVERGENT)),
      );

    const mode = new DiagnosisMode();
    const context = makeContext();
    const events = await collectEvents(
      mode,
      context.definition,
      "商户 10086 活体通过率下降",
      context,
    );

    const completed = events.find((e) => e.type === "team_completed");
    const output = (completed as { output: Record<string, unknown> }).output;
    expect(output.resolution).toBe("divergent");
  });

  it("handles frontend JSON parse failure gracefully", async () => {
    mockAgentRun.mockReturnValue(
      makeAgentRespond("摄像头权限问题，用户需要开启HTTPS并授予权限"),
    );

    const mode = new DiagnosisMode();
    const context = makeContext();
    const events = await collectEvents(
      mode,
      context.definition,
      "H5摄像头打不开",
      context,
    );

    const completed = events.find((e) => e.type === "team_completed");
    const output = (completed as { output: Record<string, unknown> }).output;
    // JSON parse fallback: need_escalation defaults to false → fast track
    expect(output.resolution).toBe("frontend_only");
    expect(mockAgentRun).toHaveBeenCalledTimes(1);
  });

  it("rule escalation overrides LLM when backend codes found in output", async () => {
    // LLM says no escalation, but output contains FACE_TIMEOUT
    const frontendWithBackendCode = JSON.stringify({
      conclusion:
        "用户活体采集失败，trace 中出现了 FACE_TIMEOUT 错误码",
      evidence: [{ type: "trace", detail: "FACE_TIMEOUT detected" }],
      need_escalation: false, // LLM wrongly says no
      escalation_reason: null,
      context_for_backend: {},
    });

    mockAgentRun
      .mockReturnValueOnce(makeAgentRespond(frontendWithBackendCode))
      .mockReturnValueOnce(makeAgentRespond(JSON.stringify(BACKEND_STRONG)))
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(SCORING_BACKEND_WINS)),
      );

    const mode = new DiagnosisMode();
    const context = makeContext();
    const events = await collectEvents(
      mode,
      context.definition,
      "traceId abc123 刷脸失败",
      context,
    );

    // Rule trigger should force escalation → all 3 agents run
    const startedAgents = events
      .filter((e) => e.type === "agent_started")
      .map((e) => (e as { agentName: string }).agentName);
    expect(startedAgents).toContain("backend_agent");
    expect(startedAgents).toContain("leader");
    expect(mockAgentRun).toHaveBeenCalledTimes(3);
  });

  it("rule escalation uses the original task when the frontend omits the code", async () => {
    const frontendWithoutCode = JSON.stringify({
      conclusion: "问题已定位",
      evidence: [],
      need_escalation: false,
      escalation_reason: null,
      context_for_backend: {},
    });

    mockAgentRun
      .mockReturnValueOnce(makeAgentRespond(frontendWithoutCode))
      .mockReturnValueOnce(makeAgentRespond(JSON.stringify(BACKEND_STRONG)))
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(SCORING_BACKEND_WINS)),
      );

    const mode = new DiagnosisMode();
    const context = makeContext();
    const events = await collectEvents(
      mode,
      context.definition,
      "ACE_TIMEOUT 错误怎么排查",
      context,
    );

    const startedAgents = events
      .filter((e) => e.type === "agent_started")
      .map((e) => (e as { agentName: string }).agentName);
    expect(startedAgents).toEqual([
      "frontend_agent",
      "backend_agent",
      "leader",
    ]);
    expect(mockAgentRun).toHaveBeenCalledTimes(3);
  });

  it("blackboard stores all checkpoints correctly", async () => {
    mockAgentRun
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(FRONTEND_WITH_ESCALATION)),
      )
      .mockReturnValueOnce(makeAgentRespond(JSON.stringify(BACKEND_STRONG)))
      .mockReturnValueOnce(
        makeAgentRespond(JSON.stringify(SCORING_BACKEND_WINS)),
      );

    const mode = new DiagnosisMode();
    const context = makeContext();
    await collectEvents(
      mode,
      context.definition,
      "traceId abc123 用户刷脸失败",
      context,
    );

    const bb = context.blackboard;
    expect(bb.has("task")).toBe(true);
    expect(bb.has("frontend_conclusion")).toBe(true);
    expect(bb.has("context_for_backend")).toBe(true);
    expect(bb.has("backend_conclusion")).toBe(true);
    expect(bb.has("scoring_result")).toBe(true);

    // context_for_backend should NOT contain the frontend conclusion
    const ctxForBackend = bb.read("context_for_backend") as Record<
      string,
      unknown
    >;
    expect(ctxForBackend.traceId).toBe("abc123");
    // Only factual data, no conclusion field leaked
    expect(ctxForBackend.conclusion).toBeUndefined();
  });

  it("validation fails when no frontend_agent in team definition", async () => {
    const mode = new DiagnosisMode();
    const def = {
      ...makeTeamDefinition(),
      agents: [
        {
          name: "backend_agent",
          displayName: "后端",
          description: "",
          systemPrompt: "",
          tools: [],
          maxIterations: 3,
          priority: 5,
          canDelegate: false,
          canBroadcast: false,
        },
      ],
    };
    const context = makeContext({ definition: def });

    const events = await collectEvents(mode, def, "some task", context);
    const failed = events.find((e) => e.type === "team_failed");
    expect(failed).toBeDefined();
    expect((failed as { error: string }).error).toContain("frontend_agent");
  });
});
