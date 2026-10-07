import { createHmac } from "node:crypto";
import { prisma } from "../../db.js";
import type { ExecutionScope } from "../../runtime/scope.js";
import type { RouteContext, RouteStreamEvent } from "./types.js";

export async function hasConfiguredDiagnosis(conversationId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ active: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM agent_flows WHERE enabled = true AND scene = 'diagnosis'
      UNION ALL
      SELECT 1 FROM agent_flow_runs
        WHERE conversation_id = ${conversationId} AND test = false AND status = 'waiting_input'
    ) AS active
  `;
  return rows[0]?.active ?? false;
}

export async function hasWaitingConfiguredDiagnosis(conversationId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ active: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM agent_flow_runs
        WHERE conversation_id = ${conversationId} AND test = false AND status = 'waiting_input'
    ) AS active
  `;
  return rows[0]?.active ?? false;
}

export async function* configuredDiagnosis(
  context: RouteContext,
  scope?: ExecutionScope,
): AsyncGenerator<RouteStreamEvent> {
  const path = "/api/agent-flows/runtime/diagnose";
  const body = JSON.stringify({
    conversationId: context.conversationId,
    sessionId: context.sessionId,
    userMessage: context.userMessage,
    assistantMsgId: context.assistantMsgId,
    resolvedModel: context.resolvedModel,
    providerName: context.providerName,
  });
  const stamp = String(Math.floor(Date.now() / 1000));
  const secret = process.env.JWT_SECRET || "agentforge-dev-secret-change-in-production";
  const signature = createHmac("sha256", secret).update(`${stamp}\n${path}\n${body}`).digest("hex");
  const base = process.env.AGENT_FLOW_BACKEND_URL || "http://127.0.0.1:8004";
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Flow-Timestamp": stamp,
      "X-Agent-Flow-Signature": signature,
    },
    body,
    signal: scope?.context.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`配置诊断服务不可用 (${response.status})，请检查后端地址及共享数据库`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const allowed = new Set([
    "diagnosis_started", "diagnosis_phase", "diagnosis_phase_done", "diagnosis_completed",
    "diagnosis_waiting_input", "clarification_needed", "token", "done", "error",
  ]);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      if (buffer.length > 1048576) throw new Error("Configured diagnosis event exceeds size limit");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data) as RouteStreamEvent;
        if (!allowed.has(event.type)) throw new Error("Unexpected configured diagnosis event");
        if (event.type === "done") {
          event.memory = { injected: context.injectedMemories.length, extracted: 0 };
          completed = true;
        }
        yield event;
      }
    }
    if (!completed) throw new Error("Configured diagnosis stream ended before completion");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
