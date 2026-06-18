// AgentExecutor —— 统一的 TASK 路由 Agent 执行器
//
// 包装 AgentService.run() 的 ReAct 循环，实现：
//   - 动态工具获取（ToolRegistry.getAvailable()）
//   - KnowledgeContext 结构化注入
//   - ContentBlock 富媒体输出
//   - Citation 引证校验
//   - SSE 流式事件映射
//
// 以后任何新场景只需注册新工具到 ToolRegistry，无需新建 Agent 文件。

import { randomUUID } from "crypto";
import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import type { ExecutionScope } from "../../runtime/scope.js";
import { prisma } from "../../db.js";
import { logger } from "@agentforge/logger";
import {
  agentReActIterations,
  agentToolCallsTotal,
  agentCitationCoverage,
} from "../../observability/metrics.js";
import { AgentService } from "../agent.js";
import type { CitationReport } from "./citation-verifier.js";
import { getCitationVerifier } from "./citation-verifier.js";
import { validateBusinessResponse } from "./validation.js";
import { KnowledgeContextBuilder } from "./knowledge-context.js";
import { toolRegistry } from "../../tools/registry.js";

// ── 硬编码最终兜底文案 ──
const HARDCODED_FALLBACK =
  "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";

// ── Agent 业务阶段 ──
type AgentPhase =
  | "planning"
  | "executing"
  | "observing"
  | "responding"
  | "finished";

// ── 输出生命周期 ──
interface OutputState {
  visibleChars: number;
  responseStarted: boolean;
  responseCompleted: boolean;
}

// ── 响应内容 ──
interface ResponseEnvelope {
  finalContent?: string;
  fallbackContent?: string;
}

// ═══════════════════════════════════════════════════════
// AgentExecutor
// ═══════════════════════════════════════════════════════

export class AgentExecutor implements RouteAgent {
  readonly route = "TASK" as const;

  async *execute(
    context: RouteContext,
    scope?: ExecutionScope,
  ): AsyncGenerator<RouteStreamEvent> {
    const {
      conversationId,
      sessionId,
      userMessage,
      resolvedModel,
      providerName,
      withinServiceHours,
      assistantMsgId,
      intent,
    } = context;

    // 发送 meta
    yield {
      type: "meta",
      message_id: assistantMsgId,
      session_id: sessionId,
      model: resolvedModel,
      provider: providerName,
      knowledge: [],
      intent,
      within_service_hours: withinServiceHours,
      memory_count: 0,
      route: "TASK",
    };

    let finalAnswer = "";
    let suggestions: string[] = [];
    let accumulatedContent = "";
    const collectedKBChunks: string[] = [];
    let citationReport: CitationReport | null = null;

    // KnowledgeContext 构建：从 search_knowledge_base 工具结果中提取结构化上下文
    let lastKBToolResult: string | null = null;
    const kbBuilder = new KnowledgeContextBuilder();

    let phase: AgentPhase = "planning";
    const outputState: OutputState = {
      visibleChars: 0,
      responseStarted: false,
      responseCompleted: false,
    };
    const envelope: ResponseEnvelope = {};
    let iterationCount = 0;

    try {
      const agentService = new AgentService();

      // ── 构建任务描述 ──
      // KnowledgeContext 在 Agent 执行后由 KnowledgeContextBuilder 构建，
      // 用于 CitationVerifier 引证校验和 Validation 管线，不预注入 system prompt。
      const task = `用户询问：${userMessage}

请使用可用工具帮助用户解决问题。回答要简洁、专业、友好。
如果工具返回了数据，请直接用自然语言 + Markdown 表格或列表向用户解释结果。
如果知识库有相关信息，请引用来源。`;

      // ── 动态获取工具列表（从 ToolRegistry） ──
      const enabledTools = this.getAvailableToolNames();

      // 运行 Agent ReAct 循环
      const events = agentService.run(conversationId, task, {
        model: resolvedModel,
        maxIterations: 5,
        tools: enabledTools,
        scope,
        skipUserMessageSave: true,
        guardConfig: {
          maxTokens: 2000,
          maxCostCents: 5,
        },
      });

      // 映射 agent 事件 → agent-runtime SSE 事件
      for await (const event of events) {
        if (scope?.controller.shouldStop) break;

        switch (event.type) {
          case "agent_token":
            if ("content" in event) {
              const token = event.content as string;
              if (phase === "responding") {
                accumulatedContent += token;
                yield {
                  type: "token",
                  content: token,
                  message_id: assistantMsgId,
                };
                outputState.visibleChars++;
              } else {
                accumulatedContent += token;
              }
            }
            break;

          case "agent_responding":
            phase = "responding";
            outputState.responseStarted = true;
            break;

          case "agent_clear_stream":
            accumulatedContent = "";
            break;

          case "agent_observe":
            phase = "observing";
            iterationCount++;
            if ("tool" in event && event.tool) {
              agentToolCallsTotal.inc({
                tool_name: String(event.tool),
                status: "success",
                route: "TASK",
              });
            }
            if ("result" in event && event.result) {
              const resultStr = event.result as string;
              const kbChunks = extractKBChunks(resultStr);
              if (kbChunks.length > 0) {
                collectedKBChunks.push(...kbChunks);
                // 保存最近一次 search_knowledge_base 的原始输出供 KnowledgeContext 构建
                if (isKnowledgeBaseResult(resultStr)) {
                  lastKBToolResult = resultStr;
                }
              }
            }
            break;

          case "agent_respond":
            if ("content" in event) {
              envelope.finalContent = event.content as string;
              finalAnswer = envelope.finalContent;

              if (!outputState.responseStarted) {
                for (const char of envelope.finalContent) {
                  yield {
                    type: "token",
                    content: char,
                    message_id: assistantMsgId,
                  };
                  outputState.visibleChars++;
                }
                outputState.responseStarted = true;
              }
              outputState.responseCompleted = true;
            }
            break;

          case "agent_error":
            logger.warn(
              { error: "error" in event ? event.error : "unknown" },
              "AgentExecutor agent error",
            );
            if (!envelope.fallbackContent) {
              envelope.fallbackContent = HARDCODED_FALLBACK;
            }
            break;

          case "agent_done":
            phase = "finished";
            break;

          default:
            break;
        }
      }

      // ReAct 迭代指标
      agentReActIterations.observe(
        { agent_type: "agent_executor" },
        iterationCount,
      );

      // ── Interruption ──
      if (scope?.controller.shouldStop) {
        const partialContent = accumulatedContent || envelope.finalContent || "";
        if (partialContent) {
          // 持久化部分内容到 DB
          try {
            await prisma.message.create({
              data: {
                id: assistantMsgId,
                conversationId,
                role: "assistant",
                content: partialContent,
                model: resolvedModel,
              },
            });
          } catch (err) {
            logger.warn(
              { error: err instanceof Error ? err.message : "Unknown error", conversationId },
              "Failed to persist partial agent-executor content on interrupt",
            );
          }

          // 仅在尚未流式输出时补偿输出（phase !== "responding" 时 token 仅缓存未发送）
          if (!outputState.responseStarted) {
            for (const char of partialContent) {
              yield { type: "token", content: char, message_id: assistantMsgId };
            }
          }
        }
        yield {
          type: "done",
          message_id: assistantMsgId,
          usage: {},
          suggestions: undefined,
          memory: { injected: 0, extracted: 0 },
          validated: false,
          fallback_used: !partialContent || undefined,
          route: "TASK",
        };
        return;
      }

      // ── 安全网：检测并清除泄漏的 ReAct JSON ──
      if (finalAnswer) {
        const sanitized = sanitizeReActJSON(finalAnswer);
        if (sanitized === null) {
          logger.warn(
            { finalAnswer: finalAnswer.slice(0, 200) },
            "ReAct JSON leaked to final answer, using fallback",
          );
          envelope.finalContent = undefined;
          if (!envelope.fallbackContent) {
            envelope.fallbackContent =
              "抱歉，查询未找到结果。请检查您提供的信息是否正确，或联系人工客服获取帮助。";
          }
          suggestions = ["转接人工客服"];
        } else {
          envelope.finalContent = sanitized;
          finalAnswer = sanitized;
        }
      }

      // ── KnowledgeContext 构建：从 search_knowledge_base 工具结果提取结构化上下文 ──
      let knowledgeContext = null;
      if (lastKBToolResult && finalAnswer) {
        try {
          knowledgeContext = kbBuilder.build(lastKBToolResult, userMessage);
          if (knowledgeContext) {
            logger.debug(
              { confidence: knowledgeContext.confidence, docs: knowledgeContext.docs.length },
              "KnowledgeContext built from KB tool results",
            );
          }
        } catch (e) {
          logger.warn(e, "KnowledgeContext building skipped");
        }
      }

      // ── Citation 引证校验 ──
      if (finalAnswer && collectedKBChunks.length > 0) {
        try {
          const verifier = getCitationVerifier();
          citationReport = await verifier.verify(
            finalAnswer,
            collectedKBChunks,
          );
          agentCitationCoverage.observe(
            { level: citationReport.level },
            citationReport.coverageRate,
          );
        } catch (e) {
          logger.warn(e, "Citation verification skipped");
        }
      }

      // ── 业务回复校验 ──
      if (finalAnswer) {
        const validationResult = validateBusinessResponse(
          finalAnswer,
          collectedKBChunks,
          citationReport ?? undefined,
        );
        if (!validationResult.valid) {
          logger.warn(
            { errors: validationResult.errors, layer: validationResult.layer },
            "Business response validation failed",
          );
          // Layer 3（禁止行为）/ Layer 5（疑似编造）→ 追加免责声明
          if (validationResult.layer === 3 || validationResult.layer === 5) {
            finalAnswer +=
              "\n\n⚠ *以上信息可能不准确，建议核实后参考。*";
            envelope.finalContent = finalAnswer;
          }
        }
      }
    } catch (e) {
      logger.error(e, "AgentExecutor execution failed");
      if (!envelope.fallbackContent) {
        envelope.fallbackContent = HARDCODED_FALLBACK;
      }
    }

    // ── Post-processing：唯一补偿出口 ──
    // 如果 agent_respond 未触发但 agent_responding 已流式输出了 token，
    // 且没有错误回退内容 → 标记为已完成，避免重复输出。
    // 如果有 fallbackContent（agent_error 触发），仍需补偿输出替换受损内容。
    if (!outputState.responseCompleted && outputState.responseStarted && outputState.visibleChars > 0 && !envelope.fallbackContent) {
      outputState.responseCompleted = true;
    }

    let fallbackUsed = false;
    if (!outputState.responseCompleted) {
      const resolved =
        envelope.finalContent ??
        envelope.fallbackContent ??
        sanitizeReActJSON(accumulatedContent);
      const content = resolved || HARDCODED_FALLBACK;

      fallbackUsed = content === HARDCODED_FALLBACK;

      for (const char of content) {
        yield {
          type: "token",
          content: char,
          message_id: assistantMsgId,
        };
        outputState.visibleChars++;
      }
      outputState.responseCompleted = true;
    }

    // 发送 done
    yield {
      type: "done",
      message_id: assistantMsgId,
      usage: {},
      suggestions:
        suggestions.length > 0
          ? suggestions
          : fallbackUsed
            ? ["转接人工客服"]
            : undefined,
      memory: { injected: 0, extracted: 0 },
      validated: true,
      fallback_used: fallbackUsed || undefined,
      route: "TASK",
      citation: citationReport
        ? {
            level: citationReport.level,
            coverageRate: citationReport.coverageRate,
            avgScore: citationReport.avgScore,
            uncitedCount: citationReport.sentences.filter(
              (s) => s.isFactual && s.status === "uncited",
            ).length,
          }
        : undefined,
    };
  }

  /**
   * 从 ToolRegistry 动态获取 TASK 路由可用的工具名称列表。
   * 返回所有已注册的工具——Agent 在 ReAct 循环中自主选择。
   */
  private getAvailableToolNames(): string[] {
    return toolRegistry.listNames();
  }
}

// ═══════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════

/**
 * 检测并清理 ReAct Agent 内部 JSON 输出（防止泄漏到用户界面）
 */
export function sanitizeReActJSON(text: string): string | null {
  const trimmed = text.trim();

  const looksLikeReActJSON =
    trimmed.startsWith("{") &&
    /"observation"\s*:/.test(trimmed) &&
    /"analysis"\s*:/.test(trimmed) &&
    /"plan"\s*:/.test(trimmed);

  if (!looksLikeReActJSON) return text;

  try {
    const parsed = JSON.parse(trimmed);
    const decision = parsed.decision;

    // 优先：decision 中的 content 字段（LLM 尝试回答）
    if (typeof decision === "object" && decision?.content) {
      return String(decision.content);
    }

    // decision 是动作（如 search_knowledge_base）但没有 content → 无法直接展示
    if (typeof decision === "string") {
      return null;
    }

    // 次选：顶层的 content / summary 字段
    if (parsed.content && typeof parsed.content === "string") {
      return parsed.content;
    }
    if (parsed.summary && typeof parsed.summary === "string") {
      return parsed.summary;
    }

    // 再次：plan 或 observation 可能包含可读信息
    if (typeof parsed.plan === "string" && parsed.plan.trim()) {
      return parsed.plan.trim();
    }
    if (typeof parsed.observation === "string" && parsed.observation.trim()) {
      return parsed.observation.trim();
    }

    return null;
  } catch {
    // Expected: ReAct JSON extraction is best-effort — returns null for non-JSON content
    return null;
  }
}

/**
 * 检测工具输出是否为 search_knowledge_base 的返回结果。
 */
function isKnowledgeBaseResult(toolResult: string): boolean {
  return toolResult.includes('"results"') && toolResult.includes('"found"');
}

/**
 * 从 search_knowledge_base 工具返回的 JSON 中提取 KB chunk 文本。
 */
function extractKBChunks(toolResult: string): string[] {
  if (!toolResult.includes('"results"') || !toolResult.includes('"found"')) {
    return [];
  }
  try {
    const data = JSON.parse(toolResult.trim());
    if (!data.found || !Array.isArray(data.results)) return [];
    return data.results
      .filter((r: unknown) => typeof r === "object" && r !== null)
      .map((r: Record<string, unknown>) => String(r.content ?? ""))
      .filter((s: string) => s.length > 0);
  } catch {
    // Expected: malformed tool output — return empty array as safe fallback
    return [];
  }
}
