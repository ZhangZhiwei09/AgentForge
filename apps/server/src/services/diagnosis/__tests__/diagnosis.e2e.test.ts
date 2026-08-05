// 端到端测试：DiagnosisService × 真实模拟监控 MCP server。
//
// 真实拉起 apps/server-py 的 MCP server 子进程，走完整链路：
// 用户 query → 意图分类（single_trace_diagnosis）→ 确定性工具规划（选中
// query_trace_log）→ MonitoringMcpClient 真实调用 MCP → McpDiagnosisMonitoringTools
// 解析 → 合并证据 → 生成诊断结论。
//
// 工具选择由诊断图的 buildToolPlan 确定性完成（不依赖真实 LLM，测试可复现）；
// 多 agent 场景下由 LLM 选择工具的部分属于 teams DiagnosisMode，不在本测试范围。

import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import type { HybridSearchResult } from "../../knowledge.js";
import { DiagnosisService } from "../graph.js";
import { settings } from "../../../config.js";

const fakeDocs: HybridSearchResult[] = [
  {
    chunkId: "chunk-face-timeout",
    docId: "doc-error-code",
    kbId: "kb-identity",
    content:
      "FACE_TIMEOUT 通常表示活体采集或人脸核验链路超时，需要检查网络、摄像头权限、SDK 版本和接口耗时。",
    score: 0.93,
    fusionScore: 0.03,
    recallSources: ["elasticsearch"],
    chunkIndex: 0,
    docTitle: "活体错误码排查手册",
  },
];

// 从 vitest cwd（apps/server）定位 apps/server-py
const serverPyDir = path.resolve(process.cwd(), "../server-py");

let proc: ChildProcess | null = null;
let port = 0;

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

function waitForPort(target: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port: target });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`MCP server 未在 ${timeoutMs}ms 内就绪`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

beforeAll(async () => {
  port = await getFreePort();
  proc = spawn(
    "uv",
    ["run", "python", "-m", "src.mcp.monitoring.server", "--port", String(port)],
    { cwd: serverPyDir, stdio: ["ignore", "ignore", "pipe"] },
  );
  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[mcp-server] ${chunk.toString()}`);
  });
  await waitForPort(port, 20_000);
  // 将单例客户端指向本次拉起的 server
  settings.mcpMonitoringUrl = `http://127.0.0.1:${port}/mcp`;
}, 40_000);

afterAll(() => {
  if (proc) {
    proc.kill();
    proc = null;
  }
});

function createService() {
  const knowledgeRetriever = {
    searchHybrid: vi.fn(async () => fakeDocs),
  };
  const service = new DiagnosisService({ knowledgeRetriever });
  return { service, knowledgeRetriever };
}

describe("DiagnosisService E2E over real MCP server", () => {
  it("queries real MCP trace data and produces a conclusion", async () => {
    const { service } = createService();
    const result = await service.run({
      query: "traceId abc123 用户刷脸失败，帮忙看下",
    });

    expect(result.intent).toBe("single_trace_diagnosis");
    expect(result.status).toBe("diagnosed");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].ok).toBe(true);
    // 数据来自真实 MCP 调用（abc123 = 算法超时场景，5 个 span）
    expect(result.toolResults[0].data.errorCode).toBe("FACE_TIMEOUT");
    expect(result.toolResults[0].data.spans).toHaveLength(5);
    expect(result.answer).toContain("算法节点");
  });

  it("returns the default trace for an unknown traceId", async () => {
    const { service } = createService();
    const result = await service.run({
      query: "traceId not_exist_xyz 用户刷脸失败，帮忙看下",
    });

    expect(result.toolResults[0].ok).toBe(true);
    expect(result.toolResults[0].data.errorCode).toBe("UNKNOWN_VERIFY_FAIL");
  });
});
