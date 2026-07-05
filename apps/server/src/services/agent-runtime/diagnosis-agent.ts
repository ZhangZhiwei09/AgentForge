// DiagnosisRouteAgent —— DIAGNOSIS 路由 Agent
//
// 包装身份诊断 Team（identity-diagnosis template），将 Team SSE 事件流
// 翻译为 Chat SSE 事件流（diagnosis_started → diagnosis_phase → diagnosis_phase_done → diagnosis_completed）。
//
// 兜底策略：
//   - Team instantiate 失败 → 降级为普通 TASK Agent
//   - 诊断超时（60s）→ 中断，返回已有结果 + 提示
//   - 用户取消 → scope.controller.shouldStop 中断

import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import type { ExecutionScope } from "../../runtime/scope.js";
import type { TeamStreamEvent } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import { teamService } from "../../teams/service.js";

const AGENT_USER_ID = "00000000-0000-0000-0000-000000000002";
const DIAGNOSIS_TEMPLATE_ID = "identity-diagnosis";
const DIAGNOSIS_TIMEOUT_MS = 60_000;

// Agent name → phase number mapping
const AGENT_PHASE_MAP: Record<string, number> = {
  frontend_agent: 1,
  backend_agent: 2,
  leader: 3,
};

const AGENT_LABEL_MAP: Record<string, string> = {
  frontend_agent: "前端排查",
  backend_agent: "后端排查",
  leader: "综合分析",
};

export class DiagnosisRouteAgent implements RouteAgent {
  readonly route = "DIAGNOSIS" as const;

  async *execute(
    context: RouteContext,
    scope?: ExecutionScope,
  ): AsyncGenerator<RouteStreamEvent> {
    const messageId = context.assistantMsgId;

    // 1. 发送 meta 事件
    yield {
      type: "meta",
      message_id: messageId,
      session_id: context.sessionId,
      model: context.resolvedModel,
      provider: context.providerName,
      knowledge: context.knowledgeResults,
      intent: "diagnosis",
      within_service_hours: context.withinServiceHours,
      memory_count: context.injectedMemories.length,
      route: "DIAGNOSIS",
    };

    // 2. Instantiate identity-diagnosis team template
    let team;
    try {
      team = await teamService.createFromTemplate(
        AGENT_USER_ID,
        DIAGNOSIS_TEMPLATE_ID,
        {
          name: `诊断-${context.sessionId ?? context.conversationId.slice(0, 8)}`,
        },
      );

      if (!team) {
        throw new Error(`Template "${DIAGNOSIS_TEMPLATE_ID}" not found`);
      }
    } catch (err) {
      logger.error(
        { error: err, sessionId: context.sessionId },
        "DiagnosisRouteAgent: failed to create team from template",
      );
      yield {
        type: "error",
        content: "诊断服务暂时不可用，已切换为普通模式处理您的问题。",
      };
      return;
    }

    // 3. 运行 Team，翻译事件流（带超时保护）
    const startTime = Date.now();
    let streamedOutput = "";
    let hasCompleted = false;

    try {
      for await (const teamEvent of teamService.runTeam(
        team.id,
        AGENT_USER_ID,
        context.userMessage,
        {},
        context.conversationId,
        scope,
      )) {
        // 超时检查
        if (Date.now() - startTime > DIAGNOSIS_TIMEOUT_MS) {
          logger.warn(
            { teamId: team.id, elapsed: Date.now() - startTime },
            "DiagnosisRouteAgent: timeout reached, stopping team execution",
          );
          yield {
            type: "error",
            content: "诊断超时，已收集到的信息如下。如需进一步排查，请联系人工客服。",
          };
          break;
        }

        // 用户取消检查
        if (scope?.controller.shouldStop) {
          break;
        }

        const chatEvent = translateTeamEvent(teamEvent, messageId);
        if (chatEvent) {
          if (chatEvent.type === "diagnosis_completed") {
            hasCompleted = true;
            // 提取最终结论文本用于 streamedAnswer
            const output = (chatEvent as { output: Record<string, unknown> }).output;
            streamedOutput = extractConclusionText(output);
          }
          yield chatEvent;
        }
      }
    } catch (err) {
      logger.error(
        { error: err, teamId: team.id },
        "DiagnosisRouteAgent: team execution failed",
      );
      yield {
        type: "error",
        content: "诊断过程出现异常，请稍后重试或联系人工客服。",
      };
    }

    // 4. 流式输出最终结论文本
    if (streamedOutput) {
      for (const char of streamedOutput) {
        yield {
          type: "token",
          content: char,
          message_id: messageId,
        };
      }
    }

    // 5. 发送 done 事件
    yield {
      type: "done",
      message_id: messageId,
      usage: {},
      memory: { injected: context.injectedMemories.length, extracted: 0 },
      route: "DIAGNOSIS",
    };
  }
}

// ═════════════════════════════════════════════════════════════
// Team SSE → Chat SSE 事件翻译
// ═════════════════════════════════════════════════════════════

/**
 * 将 TeamStreamEvent 翻译为 RouteStreamEvent。
 * 返回 null 表示该 Team 事件不需要向前端发送。
 */
function translateTeamEvent(
  event: TeamStreamEvent,
  messageId: string,
): RouteStreamEvent | null {
  switch (event.type) {
    case "team_started":
      return {
        type: "diagnosis_started",
        agents: event.agents,
        message_id: messageId,
      };

    case "agent_started": {
      const phase = AGENT_PHASE_MAP[event.agentName];
      if (!phase) return null; // 忽略未识别的 agent
      return {
        type: "diagnosis_phase",
        phase,
        agent: event.agentName,
        label: AGENT_LABEL_MAP[event.agentName] ?? event.role,
        message_id: messageId,
      };
    }

    case "agent_completed": {
      const phase = AGENT_PHASE_MAP[event.agentName];
      if (!phase) return null;
      const summary = extractSummary(event.output);
      return {
        type: "diagnosis_phase_done",
        phase,
        agent: event.agentName,
        label: AGENT_LABEL_MAP[event.agentName] ?? "",
        summary,
        message_id: messageId,
      };
    }

    case "team_completed":
      return {
        type: "diagnosis_completed",
        output: event.output as Record<string, unknown>,
        message_id: messageId,
      };

    case "agent_error":
      logger.warn(
        { agentName: event.agentName, error: event.error },
        "DiagnosisRouteAgent: agent error in team",
      );
      return {
        type: "error",
        content: `诊断 Agent "${event.agentName}" 执行出错：${event.error}`,
      };

    case "team_failed":
      logger.error(
        { error: event.error },
        "DiagnosisRouteAgent: team failed",
      );
      return {
        type: "error",
        content: `诊断失败：${event.error}`,
      };

    default:
      // 忽略其他 Team 内部事件（agent_think, agent_act, blackboard_update 等）
      return null;
  }
}

// ═════════════════════════════════════════════════════════════
// 辅助函数
// ═════════════════════════════════════════════════════════════

/**
 * 从文本中提取 JSON 对象。
 * 先尝试匹配围栏代码块，再尝试匹配裸 JSON。
 */
function extractJSONFromText(text: string): Record<string, unknown> | null {
  // 先尝试匹配 ```json ... ``` 或 ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim()) as Record<string, unknown>;
    } catch {
      // 围栏内不是合法 JSON，继续尝试
    }
  }

  // 再尝试匹配裸 JSON
  const raw = text.match(/\{[\s\S]*\}/);
  if (raw) {
    try {
      return JSON.parse(raw[0]) as Record<string, unknown>;
    } catch {
      // 不是合法 JSON
    }
  }

  return null;
}

/**
 * 从 agent_completed 的 output 中提取一句话摘要。
 * output 可能是字符串（LLM 原始输出）或已解析的对象。
 */
function extractSummary(output: unknown): string {
  if (typeof output === "string") {
    // 尝试从 JSON 输出中提取 conclusion 字段
    const parsed = extractJSONFromText(output);
    if (parsed && typeof parsed.conclusion === "string") {
      return parsed.conclusion.slice(0, 200);
    }
    // 非 JSON 文本，截取前 200 字符
    return output.slice(0, 200);
  }
  if (typeof output === "object" && output !== null) {
    const obj = output as Record<string, unknown>;
    if (typeof obj.conclusion === "string") {
      return obj.conclusion.slice(0, 200);
    }
    if (typeof obj.summary === "string") {
      return obj.summary.slice(0, 200);
    }
  }
  return "";
}

/**
 * 从 diagnosis_completed 的 output 中提取最终结论文本，
 * 用于在聊天气泡中作为普通文本展示。
 */
function extractConclusionText(output: Record<string, unknown>): string {
  const resolution = String(output.resolution ?? "");

  // 尝试从 final_diagnosis 中提取结论
  const finalDiag = output.final_diagnosis as Record<string, unknown> | undefined;

  if (finalDiag) {
    if (typeof finalDiag.conclusion === "string") {
      return formatConclusionText(resolution, finalDiag.conclusion);
    }
    if (typeof finalDiag.message === "string") {
      return formatConclusionText(resolution, finalDiag.message);
    }
  }

  // 回退：直接用 conclusion 字段
  if (typeof output.conclusion === "string") {
    // conclusion 可能是 LLM 原始 JSON 文本，尝试从中提取
    const parsed = extractJSONFromText(output.conclusion);
    if (parsed && typeof parsed.conclusion === "string") {
      return formatConclusionText(resolution, parsed.conclusion);
    }
    // 如果提取失败，直接使用原文字（截断过长内容）
    const text = output.conclusion.length > 500
      ? output.conclusion.slice(0, 500) + "..."
      : output.conclusion;
    return formatConclusionText(resolution, text);
  }

  // 最终回退：JSON 序列化
  return `诊断完成。结果：${JSON.stringify(output).slice(0, 500)}`;
}

function formatConclusionText(resolution: string, conclusion: string): string {
  const prefix = RESOLUTION_PREFIX[resolution] ?? "";
  return prefix ? `${prefix}\n\n${conclusion}` : conclusion;
}

const RESOLUTION_PREFIX: Record<string, string> = {
  frontend_only: "✅ 经前端排查，问题已定位：",
  adopt_frontend: "✅ 综合诊断完成，以前端结论为主：",
  adopt_backend: "✅ 综合诊断完成，以后端结论为主：",
  divergent: "⚠️ 前后端排查结论存在分歧，以下为双方观点：",
  needs_human: "🆘 当前信息不足以自动定位根因，建议转人工处理：",
};
