import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRunContext } from "../../../runtime/context.js";
import { executionResultToContent } from "../../../runtime/results.js";

// Mock strategy: intercept prisma and crypto before importing the tool
const mockExecuteRawUnsafe = vi.fn();
// Use hex-only values so that .slice(0, 8) matches [a-f0-9]{8}
const FULL_MOCK_UUID = "abcd1234-abcd-1234-abcd-123456789abc";
const mockRandomUUID = vi.fn(() => FULL_MOCK_UUID);

vi.mock("../../../db.js", () => ({
  prisma: {
    $executeRawUnsafe: (...args: unknown[]) => mockExecuteRawUnsafe(...args),
  },
}));

vi.mock("crypto", () => ({
  randomUUID: () => mockRandomUUID(),
}));

// Dynamic import after mocks are installed
const { createSupportTicketTool } = await import("../create-ticket.js");

const testCtx = createRunContext(new AbortController().signal);

describe("createSupportTicketTool", () => {
  beforeEach(() => {
    mockExecuteRawUnsafe.mockReset();
    mockRandomUUID.mockClear();
    mockRandomUUID.mockReturnValue(FULL_MOCK_UUID);
  });

  // ────────────── Tool Metadata ──────────────

  it("should have correct tool metadata", () => {
    expect(createSupportTicketTool.definition.function.name).toBe("create_support_ticket");
    expect(createSupportTicketTool.riskLevel).toBe("mutation");
    expect(createSupportTicketTool.timeout).toBe(30_000);
    expect(createSupportTicketTool.category).toBe("business");
    expect(createSupportTicketTool.requireApproval).toBe(false);
    expect(createSupportTicketTool.parallelizable).toBe(false);
  });

  it("should have summary as required parameter", () => {
    expect(
      createSupportTicketTool.definition.function.parameters.required,
    ).toContain("summary");
  });

  it("should have priority enum with normal and urgent", () => {
    const priorityProp =
      createSupportTicketTool.definition.function.parameters.properties.priority;
    expect(priorityProp.enum).toEqual(["normal", "urgent"]);
  });

  // ────────────── Success ──────────────

  it("should create a ticket and return success result with ticket_id and status", async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(undefined);

    const result = await createSupportTicketTool.execute(
      { summary: "打印机无法连接", priority: "normal", category: "IT" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    // ticketId = TKT-{Date.now()}-{randomUUID().slice(0, 8)} = TKT-...-abcd1234
    expect(parsed.ticket_id).toMatch(/^TKT-\d+-[a-f0-9]{8}$/);
    expect(parsed.status).toBe("已创建");
    expect(parsed.priority).toBe("normal");
    expect(parsed.category).toBe("IT");
    expect(parsed.summary).toBe("打印机无法连接");
    expect(parsed.tracking_tip).toContain(parsed.ticket_id);
  });

  // ────────────── Default Priority ──────────────

  it("should default priority to normal with 24h response message when not provided", async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(undefined);

    const result = await createSupportTicketTool.execute(
      { summary: "需要重置密码" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.priority).toBe("normal");
    expect(parsed.response_time).toBe(
      "工单已创建，支持团队将在 24 小时内响应处理。",
    );
  });

  // ────────────── Urgent Priority ──────────────

  it("should return 1h response message when priority is urgent", async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(undefined);

    const result = await createSupportTicketTool.execute(
      { summary: "服务器宕机", priority: "urgent", category: "运维" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.priority).toBe("urgent");
    expect(parsed.response_time).toBe(
      "工单已标记为紧急，支持团队将在 1 小时内响应处理。",
    );
  });

  // ────────────── Default Category ──────────────

  it("should default category to 通用 when not provided", async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(undefined);

    const result = await createSupportTicketTool.execute(
      { summary: "键盘损坏" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.category).toBe("通用");
  });

  // ────────────── Default Summary ──────────────

  it("should default summary to 未提供摘要 when summary is empty string", async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(undefined);

    const result = await createSupportTicketTool.execute(
      { summary: "" },
      testCtx,
    );

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.summary).toBe("未提供摘要");
  });

  it("should default summary to 未提供摘要 when summary is missing entirely", async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(undefined);

    const result = await createSupportTicketTool.execute({}, testCtx);

    expect(result.status).toBe("success");
    const parsed = JSON.parse(executionResultToContent(result));
    expect(parsed.summary).toBe("未提供摘要");
  });

  // ────────────── SQL INSERT verification ──────────────

  it("should call prisma.$executeRawUnsafe with correct SQL INSERT and parameters", async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(undefined);
    // Fix date for deterministic test
    const fixedNow = 1737000000000;
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);

    await createSupportTicketTool.execute(
      { summary: "申请VPN权限", priority: "urgent", category: "IT" },
      testCtx,
    );

    expect(mockExecuteRawUnsafe).toHaveBeenCalledTimes(1);

    const [sql, ...params] = mockExecuteRawUnsafe.mock.calls[0];
    expect(sql).toContain("INSERT INTO support_tickets");
    expect(sql).toContain(
      "(id, ticket_id, summary, priority, category, status, created_at, updated_at)",
    );
    expect(sql).toContain(
      "VALUES ($1, $2, $3, $4, $5, 'open', NOW(), NOW())",
    );
    // params: id (uuid from first randomUUID call), ticketId, summary, priority, category
    expect(params).toHaveLength(5);
    // id column uses a separate randomUUID() call (not sliced) — full mock value
    expect(params[0]).toBe(FULL_MOCK_UUID);
    // ticketId = TKT-{fixedNow}-{randomUUID().slice(0, 8)} = TKT-1737000000000-abcd1234
    expect(params[1]).toMatch(/^TKT-1737000000000-[a-f0-9]{8}$/);
    expect(params[2]).toBe("申请VPN权限");
    expect(params[3]).toBe("urgent");
    expect(params[4]).toBe("IT");

    dateSpy.mockRestore();
  });

  // ────────────── Table Not Exist Error ──────────────

  it("should return failedResult with 工单系统尚未初始化 when table does not exist (PostgreSQL)", async () => {
    mockExecuteRawUnsafe.mockRejectedValueOnce(
      new Error('relation "support_tickets" does not exist'),
    );

    const result = await createSupportTicketTool.execute(
      { summary: "测试问题" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe("EXECUTION_ERROR");
    }
    // executionResultToContent prepends "[工具执行失败] " to failed results
    expect(executionResultToContent(result)).toContain("工单系统尚未初始化，请联系管理员。");
  });

  it("should return failedResult with 工单系统尚未初始化 when table is undefined (generic ORM)", async () => {
    mockExecuteRawUnsafe.mockRejectedValueOnce(
      new Error("undefined table"),
    );

    const result = await createSupportTicketTool.execute(
      { summary: "测试问题" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe("EXECUTION_ERROR");
    }
    expect(executionResultToContent(result)).toContain("工单系统尚未初始化，请联系管理员。");
  });

  // ────────────── General DB Error ──────────────

  it("should return failedResult with 工单创建失败 on general database error", async () => {
    mockExecuteRawUnsafe.mockRejectedValueOnce(
      new Error("connection timeout"),
    );

    const result = await createSupportTicketTool.execute(
      { summary: "测试问题" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe("EXECUTION_ERROR");
    }
    expect(executionResultToContent(result)).toContain("工单创建失败，请稍后再试或联系人工客服。");
  });

  it("should return failedResult with 工单创建失败 for non-Error thrown values", async () => {
    mockExecuteRawUnsafe.mockRejectedValueOnce("raw string error");

    const result = await createSupportTicketTool.execute(
      { summary: "测试问题" },
      testCtx,
    );

    expect(result.status).toBe("failed");
    expect(executionResultToContent(result)).toContain("工单创建失败，请稍后再试或联系人工客服。");
  });

  // ────────────── created_at timestamp ──────────────

  it("should include created_at ISO timestamp in the result", async () => {
    mockExecuteRawUnsafe.mockResolvedValueOnce(undefined);

    const before = new Date();
    const result = await createSupportTicketTool.execute(
      { summary: "时间戳测试" },
      testCtx,
    );
    const after = new Date();

    const parsed = JSON.parse(executionResultToContent(result));
    const createdAt = new Date(parsed.created_at);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
