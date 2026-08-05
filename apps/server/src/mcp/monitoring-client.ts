// MCP 监控系统客户端 —— Agent 工具与模拟监控 MCP server 之间的适配层。
//
// 设计要点：
// - 生命周期：MCP server 由部署环境负责启动（dev 脚本/turbo task，生产
//   docker-compose/k8s），本服务绝不 spawn 该进程。
// - 健康检查：仅在连接时执行一次 list_tools；此后 execute() 直接 callTool，
//   不做每请求的 tools/list，避免诊断链路额外延迟。
// - 超时：MCP_CALL_TIMEOUT_MS（默认 3000ms）包住单次调用，防 MCP server 卡死。
// - 重试：网络错误 / 超时重试 1 次（间隔 500ms）；业务错误（参数错误、返回
//   格式异常）不重试。
// - 认证：设置 MCP_API_KEY 后请求携带 Authorization: Bearer <key>，开发环境留空关闭。
// - 降级：连接失败 / 超时 / 格式异常统一返回 failedResult，走 toolRegistry 的
//   circuit breaker 容错，不影响 agent 主流程。
//
// 数据契约：MCP 返回信封 {"schemaVersion": "1.0", "data": <TraceLog>}，
// 对应 Python 端 apps/server-py/src/mcp/monitoring/schemas.py。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { logger } from "@agentforge/logger";
import { settings } from "../config.js";
import {
  ExecutionErrorCode,
  failedResult,
  successResult,
} from "../runtime/results.js";
import type { ExecutionResult } from "../runtime/results.js";
import {
  mcpCallDurationMs,
  mcpCallError,
  mcpCallTotal,
} from "../observability/metrics.js";

export const MCP_TRACE_SCHEMA_VERSION = "1.0";

// ═════════════════════════════════════════════════════════
// MCP 返回值契约（Zod 校验，对应 Python schemas.py）
// ═════════════════════════════════════════════════════════

const TraceSpanSchema = z.object({
  spanId: z.string(),
  serviceName: z.string(),
  operationName: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  durationMs: z.number(),
  status: z.enum(["ok", "error", "timeout"]),
  errorCode: z.string().nullish(),
  errorMessage: z.string().nullish(),
  tags: z.record(z.string()).optional(),
});

const TraceLogSchema = z.object({
  traceId: z.string(),
  orderId: z.string(),
  product: z.enum(["liveness", "face_verify", "ocr", "realname"]),
  clientType: z.enum(["h5", "app", "mini_program", "web"]),
  sdkVersion: z.string(),
  overallDurationMs: z.number(),
  overallStatus: z.enum(["success", "failed", "timeout"]),
  errorCode: z.string().nullish(),
  errorStage: z.string().nullish(),
  spans: z.array(TraceSpanSchema),
  conclusion: z.string(),
});

const McpTraceEnvelopeSchema = z.object({
  schemaVersion: z.string(),
  data: TraceLogSchema,
});

const RETRYABLE_DELAY_MS = 500;
const MAX_ATTEMPTS = 2;
const TOOL_NAME = "query_trace_log";

// ═════════════════════════════════════════════════════════
// 工具函数
// ═════════════════════════════════════════════════════════

function isTextContent(
  item: unknown,
): item is { type: "text"; text: string } {
  if (typeof item !== "object" || item === null) return false;
  const record = item as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string";
}

function extractTextContent(content: ReadonlyArray<unknown>): string | null {
  for (const item of content) {
    if (isTextContent(item)) return item.text;
  }
  return null;
}

/** JSON.parse + Zod 校验 MCP 信封，失败返回 null（降级不抛异常）。 */
export function parseTraceEnvelope(
  text: string,
): z.infer<typeof McpTraceEnvelopeSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = McpTraceEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof McpError && err.code === ErrorCode.RequestTimeout;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═════════════════════════════════════════════════════════
// MonitoringMcpClient
// ═════════════════════════════════════════════════════════

class MonitoringMcpClient {
  private client: Client | null = null;
  private connected = false;
  private connecting: Promise<boolean> | null = null;

  /** 启动时健康检查：连接 + 一次 list_tools。失败仅告警，不抛出。 */
  async init(): Promise<boolean> {
    return this.ensureConnected();
  }

  /** 关闭连接并释放资源（测试与优雅停机用）。 */
  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) {
      try {
        await client.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        logger.warn({ error: msg }, "关闭 MCP 客户端时发生错误");
      }
    }
  }

  async queryTraceLog(traceId: string): Promise<ExecutionResult> {
    const startedAt = Date.now();
    try {
      if (!(await this.ensureConnected())) {
        mcpCallError.inc({ tool_name: TOOL_NAME, code: "NOT_CONNECTED" });
        return failedResult(
          ExecutionErrorCode.NETWORK_ERROR,
          "MCP 监控服务不可用，无法查询链路日志。",
          true,
        );
      }
      return await this.callWithRetry(TOOL_NAME, { traceId });
    } finally {
      mcpCallDurationMs.observe({ tool_name: TOOL_NAME }, Date.now() - startedAt);
    }
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.connected && this.client) return true;
    if (!this.connecting) {
      this.connecting = this.doConnect();
    }
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async doConnect(): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      if (settings.mcpMonitoringApiKey) {
        headers["Authorization"] = `Bearer ${settings.mcpMonitoringApiKey}`;
      }
      const transport = new StreamableHTTPClientTransport(
        new URL(settings.mcpMonitoringUrl),
        { requestInit: { headers } },
      );
      const client = new Client({ name: "agentforge-server", version: "0.0.1" });
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some((t) => t.name === TOOL_NAME)) {
        logger.warn(
          { url: settings.mcpMonitoringUrl },
          `MCP 监控服务未暴露 ${TOOL_NAME} 工具`,
        );
      }
      this.client = client;
      this.connected = true;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logger.warn(
        { url: settings.mcpMonitoringUrl, error: msg },
        "MCP 监控服务连接失败，监控工具将降级返回",
      );
      this.connected = false;
      return false;
    }
  }

  private async callWithRetry(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    let last: ExecutionResult | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await this.callOnce(name, args);
      if (result.status === "success") return result;
      const retryable =
        result.status === "failed" && result.error.retryable === true;
      if (!retryable || attempt === MAX_ATTEMPTS) return result;
      last = result;
      await delay(RETRYABLE_DELAY_MS);
    }
    return (
      last ??
      failedResult(ExecutionErrorCode.EXECUTION_ERROR, "MCP 调用失败", true)
    );
  }

  private async callOnce(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    if (!this.client) {
      return failedResult(
        ExecutionErrorCode.NETWORK_ERROR,
        "MCP 客户端未连接",
        true,
      );
    }
    try {
      const result = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: settings.mcpCallTimeoutMs },
      );
      const rawContent: unknown = (result as { content?: unknown }).content;
      const text = extractTextContent(Array.isArray(rawContent) ? rawContent : []);

      if (result.isError === true) {
        mcpCallError.inc({ tool_name: name, code: "API_ERROR" });
        return failedResult(
          ExecutionErrorCode.API_ERROR,
          text ?? `MCP 工具 ${name} 返回错误`,
          false,
        );
      }
      if (!text) {
        mcpCallError.inc({ tool_name: name, code: "API_ERROR" });
        return failedResult(
          ExecutionErrorCode.API_ERROR,
          `MCP 工具 ${name} 返回内容为空`,
          false,
        );
      }

      const envelope = parseTraceEnvelope(text);
      if (!envelope) {
        mcpCallError.inc({ tool_name: name, code: "API_ERROR" });
        return failedResult(
          ExecutionErrorCode.API_ERROR,
          `MCP 工具 ${name} 返回数据格式异常`,
          false,
        );
      }
      if (envelope.schemaVersion !== MCP_TRACE_SCHEMA_VERSION) {
        logger.warn(
          { schemaVersion: envelope.schemaVersion },
          "MCP schemaVersion 与预期不一致，可能存在协议差异",
        );
      }

      mcpCallTotal.inc({ tool_name: name, status: "success" });
      return successResult(text);
    } catch (err) {
      if (isTimeoutError(err)) {
        mcpCallError.inc({ tool_name: name, code: "TIMEOUT" });
        return failedResult(
          ExecutionErrorCode.TIMEOUT,
          `MCP 调用超时（>${settings.mcpCallTimeoutMs}ms）`,
          true,
        );
      }
      mcpCallError.inc({ tool_name: name, code: "NETWORK_ERROR" });
      const msg = err instanceof Error ? err.message : "Unknown error";
      return failedResult(
        ExecutionErrorCode.NETWORK_ERROR,
        `MCP 监控服务调用失败：${msg}`,
        true,
      );
    }
  }
}

export const monitoringMcpClient = new MonitoringMcpClient();
export { MonitoringMcpClient };
