import { describe, it, expect, vi, beforeEach } from "vitest";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
// 以下两个导入用于 vi.mock 声明，类型在 mock 工厂中显式提供
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MonitoringMcpClient } from "../monitoring-client.js";
import { ExecutionErrorCode } from "../../runtime/results.js";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

const validEnvelope = {
  schemaVersion: "1.0",
  data: {
    traceId: "abc123",
    orderId: "order_1",
    product: "liveness",
    clientType: "h5",
    sdkVersion: "3.1.8",
    overallDurationMs: 6550,
    overallStatus: "failed",
    errorCode: "FACE_TIMEOUT",
    errorStage: "face_capture",
    spans: [
      {
        spanId: "s1",
        serviceName: "face-algorithm",
        operationName: "liveness_detect",
        startTime: "t",
        endTime: "t2",
        durationMs: 5200,
        status: "timeout",
        errorCode: "FACE_TIMEOUT",
        tags: { cpuUsage: "87%" },
      },
    ],
    conclusion: "算法节点负载过高。",
  },
};

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFakeClient(): FakeClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "query_trace_log" }] }),
    callTool: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function installFakeClient(fake: FakeClient): void {
  // 测试用的 mock 桩：将局部对象作为 SDK Client/Transport 实例注入
  vi.mocked(Client).mockImplementation(() => fake as unknown as Client);
  vi.mocked(StreamableHTTPClientTransport).mockImplementation(
    () => ({}) as unknown as StreamableHTTPClientTransport,
  );
}

const okCallResult = {
  content: [{ type: "text", text: JSON.stringify(validEnvelope) }],
  isError: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MonitoringMcpClient.queryTraceLog", () => {
  it("returns success for a valid trace response", async () => {
    const fake = makeFakeClient();
    fake.callTool.mockResolvedValue(okCallResult);
    installFakeClient(fake);

    const client = new MonitoringMcpClient();
    const result = await client.queryTraceLog("abc123");

    expect(result.status).toBe("success");
    expect(fake.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "query_trace_log", arguments: { traceId: "abc123" } }),
      undefined,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    if (result.status === "success") {
      const parsed = JSON.parse(result.output);
      expect(parsed.schemaVersion).toBe("1.0");
      expect(parsed.data.errorCode).toBe("FACE_TIMEOUT");
    }
  });

  it("returns retryable NETWORK_ERROR when the server is unreachable", async () => {
    const fake = makeFakeClient();
    fake.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    installFakeClient(fake);

    const client = new MonitoringMcpClient();
    const result = await client.queryTraceLog("abc123");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.NETWORK_ERROR);
      expect(result.error.retryable).toBe(true);
    }
    expect(fake.callTool).not.toHaveBeenCalled();
  });

  it("classifies a call timeout as retryable TIMEOUT", async () => {
    const fake = makeFakeClient();
    fake.callTool.mockRejectedValue(new McpError(ErrorCode.RequestTimeout, "timeout"));
    installFakeClient(fake);

    const client = new MonitoringMcpClient();
    const result = await client.queryTraceLog("abc123");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.TIMEOUT);
      expect(result.error.retryable).toBe(true);
    }
    // 超时属于可重试错误，重试 1 次后仍失败 → 共 2 次调用
    expect(fake.callTool).toHaveBeenCalledTimes(2);
  });

  it("does not retry on invalid JSON response", async () => {
    const fake = makeFakeClient();
    fake.callTool.mockResolvedValue({ content: [{ type: "text", text: "not-json" }], isError: false });
    installFakeClient(fake);

    const client = new MonitoringMcpClient();
    const result = await client.queryTraceLog("abc123");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.API_ERROR);
      expect(result.error.retryable).toBe(false);
    }
    expect(fake.callTool).toHaveBeenCalledTimes(1);
  });

  it("does not retry on business error (isError=true)", async () => {
    const fake = makeFakeClient();
    fake.callTool.mockResolvedValue({ content: [], isError: true });
    installFakeClient(fake);

    const client = new MonitoringMcpClient();
    const result = await client.queryTraceLog("abc123");

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe(ExecutionErrorCode.API_ERROR);
      expect(result.error.retryable).toBe(false);
    }
    expect(fake.callTool).toHaveBeenCalledTimes(1);
  });

  it("retries once on transient network error then succeeds", async () => {
    const fake = makeFakeClient();
    fake.callTool
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(okCallResult);
    installFakeClient(fake);

    const client = new MonitoringMcpClient();
    const result = await client.queryTraceLog("abc123");

    expect(result.status).toBe("success");
    expect(fake.callTool).toHaveBeenCalledTimes(2);
  });
});
