// HumanAgent unit tests
//
// 覆盖：
//   - route 接口合约
//   - execute() 正常流程：meta → token* → done
//   - 工作时间 / 非工作时间不同转接话术
//   - DB 会话状态升级（escalated）
//   - DB 更新失败降级（HM_ESCALATE_FAILED + error metric）
//   - 日志记录与指标上报
//   - 边缘场景：null sessionId

import { describe, it, expect, vi, beforeEach } from "vitest";
import { HumanAgent } from "../human-agent.js";
import type { RouteContext, RouteStreamEvent } from "../types.js";

// ── Hoisted Mock Refs ──

const { mockPrismaUpdate, mockLoggerWarn, mockLoggerInfo, mockMetricInc } =
  vi.hoisted(() => ({
    mockPrismaUpdate: vi.fn(),
    mockLoggerWarn: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockMetricInc: vi.fn(),
  }));

// ── Mocks ──

vi.mock("../../../db.js", () => ({
  prisma: {
    conversation: {
      update: mockPrismaUpdate,
    },
  },
}));

vi.mock("@agentforge/logger", () => ({
  logger: {
    warn: mockLoggerWarn,
    info: mockLoggerInfo,
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../observability/metrics.js", () => ({
  agentRouteInvocations: {
    inc: mockMetricInc,
  },
}));

// ── Helpers ──

function makeContext(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    conversationId: "conv-test-1",
    sessionId: "session-test-1",
    userMessage: "转人工",
    history: [],
    knowledgeContext: "",
    knowledgeResults: [],
    kbChunks: [],
    memoryContext: "",
    injectedMemories: [],
    resolvedModel: "gpt-4o-mini",
    providerName: "openai",
    withinServiceHours: true,
    assistantMsgId: "msg-test-1",
    intent: "人工客服",
    ...overrides,
  };
}

async function collectEvents(
  generator: AsyncGenerator<RouteStreamEvent>,
): Promise<RouteStreamEvent[]> {
  const events: RouteStreamEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function reconstructAnswer(events: RouteStreamEvent[]): string {
  return events
    .filter((e) => e.type === "token")
    .map((e) => ("content" in e ? (e as { content: string }).content : ""))
    .join("");
}

describe("trusted entry flow handoff", () => {
  it.each([true, false])("applies configured text and retains escalation (%s)", async (withinServiceHours) => {
    mockPrismaUpdate.mockResolvedValue({});
    const handoff = { withinHours: "配置工作时间话术", outsideHours: "配置非工作时间话术", suggestions: ["下一步"] };
    const events = await collectEvents(new HumanAgent().execute(makeContext({ withinServiceHours, handoff })));
    expect(reconstructAnswer(events)).toBe(withinServiceHours ? handoff.withinHours : handoff.outsideHours);
    expect(events.at(-1)).toMatchObject({ suggestions: handoff.suggestions, route: "HUMAN" });
    expect(mockPrismaUpdate).toHaveBeenCalledWith({ where: { id: "conv-test-1" }, data: { status: "escalated" } });
  });
});

// ═══════════════════════════════════════════════════════
// HumanAgent
// ═══════════════════════════════════════════════════════

describe("HumanAgent", () => {
  let agent: HumanAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrismaUpdate.mockResolvedValue(undefined);
    agent = new HumanAgent();
  });

  // ── 接口合约 ──

  it("route 应始终为 'HUMAN'", () => {
    expect(agent.route).toBe("HUMAN");
  });

  it("execute 方法应存在且返回 AsyncGenerator", () => {
    expect(typeof agent.execute).toBe("function");
    const gen = agent.execute(makeContext());
    expect(typeof gen.next).toBe("function");
    expect(typeof gen.return).toBe("function");
    expect(typeof gen.throw).toBe("function");
    // 清理 generator，避免 dangling async 操作
    gen.return(undefined).catch(() => {});
  });

  // ── 正常流程：meta → token → done ──

  it("execute() 应先产出 meta 事件，route 为 HUMAN", async () => {
    const ctx = makeContext();
    const events = await collectEvents(agent.execute(ctx));

    const meta = events[0];
    expect(meta.type).toBe("meta");
    expect((meta as { route: string }).route).toBe("HUMAN");
    expect((meta as { message_id: string }).message_id).toBe(ctx.assistantMsgId);
    expect((meta as { session_id: string | null }).session_id).toBe(
      ctx.sessionId,
    );
    expect((meta as { model: string }).model).toBe(ctx.resolvedModel);
    expect((meta as { provider: string }).provider).toBe(ctx.providerName);
    expect((meta as { intent: string }).intent).toBe(ctx.intent);
    expect((meta as { within_service_hours: boolean }).within_service_hours).toBe(
      ctx.withinServiceHours,
    );
    expect((meta as { memory_count: number }).memory_count).toBe(0);
    expect((meta as { knowledge: unknown[] }).knowledge).toEqual([]);
  });

  it("execute() 应在 meta 和 done 之间产出 token 事件（逐字符流式输出）", async () => {
    const ctx = makeContext();
    const events = await collectEvents(agent.execute(ctx));

    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBeGreaterThan(0);

    // 所有 token 应有正确的 message_id
    for (const token of tokens) {
      expect((token as { message_id: string }).message_id).toBe(
        ctx.assistantMsgId,
      );
    }
  });

  it("execute() 最后应产出 done 事件，route 为 HUMAN 且含固定 suggestions", async () => {
    const ctx = makeContext();
    const events = await collectEvents(agent.execute(ctx));

    const done = events[events.length - 1];
    expect(done.type).toBe("done");
    expect((done as { route: string }).route).toBe("HUMAN");
    expect((done as { message_id: string }).message_id).toBe(ctx.assistantMsgId);
    expect((done as { validated: boolean }).validated).toBe(true);
    expect((done as { usage: Record<string, unknown> }).usage).toEqual({});
    expect((done as { memory: { injected: number; extracted: number } }).memory).toEqual({
      injected: 0,
      extracted: 0,
    });
    expect((done as { suggestions: string[] }).suggestions).toEqual([
      "继续咨询其他问题",
      "关闭会话",
    ]);
  });

  it("execute() 事件序列应保持 meta → token* → done 结构", async () => {
    const ctx = makeContext();
    const events = await collectEvents(agent.execute(ctx));

    // 至少 meta + 1 个 token + done
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0].type).toBe("meta");
    expect(events[events.length - 1].type).toBe("done");

    // 中间事件全部为 token
    const middleEvents = events.slice(1, -1);
    expect(middleEvents.length).toBeGreaterThan(0);
    for (const event of middleEvents) {
      expect(event.type).toBe("token");
    }
  });

  // ── 工作时间 / 非工作时间话术 ──

  it("工作时间（withinServiceHours=true）应返回服务时间内的转接话术", async () => {
    const ctx = makeContext({ withinServiceHours: true });
    const events = await collectEvents(agent.execute(ctx));
    const answer = reconstructAnswer(events);

    expect(answer).toContain("正在为您转接人工客服");
    expect(answer).toContain("会话摘要已发送给客服人员");
    expect(answer).not.toContain("非工作时间");
  });

  it("非工作时间（withinServiceHours=false）应返回非工作时间的转接话术", async () => {
    const ctx = makeContext({ withinServiceHours: false });
    const events = await collectEvents(agent.execute(ctx));
    const answer = reconstructAnswer(events);

    expect(answer).toContain("非工作时间");
    expect(answer).toContain("工作日 9:00-18:00");
    expect(answer).toContain("您的问题已记录");
    expect(answer).not.toContain("正在为您转接人工客服");
  });

  // ── DB 会话状态升级 ──

  it("execute() 应将 conversation 状态更新为 escalated", async () => {
    const ctx = makeContext({ conversationId: "conv-escalate-1" });
    await collectEvents(agent.execute(ctx));

    expect(mockPrismaUpdate).toHaveBeenCalledTimes(1);
    expect(mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: "conv-escalate-1" },
      data: { status: "escalated" },
    });
  });

  it("DB 更新应在产出第一个事件（meta）之前完成", async () => {
    // 由于 source 中 await prisma.conversation.update() 在第一个 yield 之前，
    // 这里验证 DB 调用先于第一个 yield 执行
    const callOrder: string[] = [];

    mockPrismaUpdate.mockImplementation(async () => {
      callOrder.push("db-update");
    });

    const ctx = makeContext();
    const gen = agent.execute(ctx);

    // 在第一个 yield 之前，db-update 应已被调用
    const result = await gen.next();
    expect(callOrder).toEqual(["db-update"]);
    expect((result.value as { type: string }).type).toBe("meta");
  });

  // ── DB 更新失败降级 ──

  it("DB 更新失败时应记录 HM_ESCALATE_FAILED 日志并递增 error 指标，且继续产出完整事件", async () => {
    const dbError = new Error("Database connection lost");
    mockPrismaUpdate.mockRejectedValueOnce(dbError);

    const ctx = makeContext();
    const events = await collectEvents(agent.execute(ctx));

    // 应记录 warn 日志（含 errorCode）
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      { errorCode: "HM_ESCALATE_FAILED", err: dbError },
      "Failed to update conversation status to escalated",
    );

    // 应递增 error 指标
    expect(mockMetricInc).toHaveBeenCalledWith({
      route: "HUMAN",
      status: "error",
    });

    // 即使 DB 失败，仍应产出完整的 meta + token + done 事件序列
    expect(events[0].type).toBe("meta");

    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBeGreaterThan(0);

    const done = events[events.length - 1];
    expect(done.type).toBe("done");
    expect((done as { route: string }).route).toBe("HUMAN");
  });

  it("DB 更新失败后仍应产出完整的转接消息文本", async () => {
    mockPrismaUpdate.mockRejectedValueOnce(new Error("DB down"));

    const ctx = makeContext({ withinServiceHours: true });
    const events = await collectEvents(agent.execute(ctx));
    const answer = reconstructAnswer(events);

    // 即使 DB 失败，转接消息仍应完整输出
    expect(answer).toContain("正在为您转接人工客服");
    expect(answer).toContain("会话摘要已发送给客服人员");
  });

  // ── 日志记录 ──

  it("execute() 应记录升级事件日志（含 conversationId / sessionId / reason）", async () => {
    const ctx = makeContext({
      conversationId: "conv-log-1",
      sessionId: "session-log-1",
      withinServiceHours: false,
    });

    await collectEvents(agent.execute(ctx));

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      {
        conversationId: "conv-log-1",
        sessionId: "session-log-1",
        withinServiceHours: false,
        reason: "HUMAN_ROUTE_TRIGGERED",
      },
      "HumanAgent escalating to human support",
    );
  });

  // ── 指标上报 ──

  it("execute() 正常完成后应递增 success 指标", async () => {
    const ctx = makeContext();
    await collectEvents(agent.execute(ctx));

    expect(mockMetricInc).toHaveBeenCalledWith({
      route: "HUMAN",
      status: "success",
    });
  });

  it("execute() 正常完成时 metrics 仅被调用一次（success）", async () => {
    const ctx = makeContext();
    await collectEvents(agent.execute(ctx));

    // 无 DB 错误时只有 success，没有 error
    const calls = mockMetricInc.mock.calls as Array<[Record<string, string>]>;
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toEqual({ route: "HUMAN", status: "success" });
  });

  it("DB 更新失败时 metrics 应分别记录 error 与 success 各一次", async () => {
    mockPrismaUpdate.mockRejectedValueOnce(new Error("DB down"));

    const ctx = makeContext();
    await collectEvents(agent.execute(ctx));

    // error 指标（DB 失败时 catch 块中）
    expect(mockMetricInc).toHaveBeenCalledWith({
      route: "HUMAN",
      status: "error",
    });
    // success 指标（流程最终完成后）
    expect(mockMetricInc).toHaveBeenCalledWith({
      route: "HUMAN",
      status: "success",
    });

    // 共两次调用：error + success
    const calls = mockMetricInc.mock.calls as Array<[Record<string, string>]>;
    expect(calls.length).toBe(2);
  });

  // ── 边缘场景 ──

  it("sessionId 为 null 时应正常工作", async () => {
    const ctx = makeContext({ sessionId: null });
    const events = await collectEvents(agent.execute(ctx));

    const meta = events[0];
    expect(meta.type).toBe("meta");
    expect((meta as { session_id: string | null }).session_id).toBeNull();

    // 完整事件序列仍应产出
    const done = events[events.length - 1];
    expect(done.type).toBe("done");
  });

  it("不同的 conversationId 应传递到 DB 更新中", async () => {
    const ctx1 = makeContext({ conversationId: "conv-a" });
    await collectEvents(agent.execute(ctx1));
    expect(mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: "conv-a" },
      data: { status: "escalated" },
    });

    vi.clearAllMocks();
    mockPrismaUpdate.mockResolvedValue(undefined);

    const ctx2 = makeContext({ conversationId: "conv-b" });
    await collectEvents(agent.execute(ctx2));
    expect(mockPrismaUpdate).toHaveBeenCalledWith({
      where: { id: "conv-b" },
      data: { status: "escalated" },
    });
  });

  it("execute() 不应抛出异常（DB 更新失败时也应是安全的）", async () => {
    mockPrismaUpdate.mockRejectedValueOnce(new Error("Fatal DB error"));

    const ctx = makeContext();
    // 不应 throw
    await expect(collectEvents(agent.execute(ctx))).resolves.toBeDefined();
  });

  // ── 超时逻辑 ──
  // HumanAgent.execute() 当前不含超时 / auto-reject 逻辑。
  // 若未来加入 5 分钟超时自动拒绝，需在此补充测试。
});
