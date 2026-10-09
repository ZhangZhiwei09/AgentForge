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

import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import type { TraceStep } from "@agentforge/shared-types";
import type { ExecutionScope } from "../../runtime/scope.js";
import { prisma } from "../../db.js";
import { logger } from "@agentforge/logger";
import type { ObservabilityTrace } from "../../observability/provider.js";
import {
  agentReActIterations,
  agentToolCallsTotal,
  agentCitationCoverage,
  agentMemoryRecordFailures,
} from "../../observability/metrics.js";
import { AgentService } from "../agent.js";
import { sanitizeReActJSON } from "./react-json-utils.js";
import type { CitationReport } from "./citation-verifier.js";
import { getCitationVerifier } from "./citation-verifier.js";
import { validateBusinessResponse } from "./validation.js";
import { KnowledgeContextBuilder, toCitationCards } from "./knowledge-context.js";
import { toolRegistry } from "../../tools/registry.js";
import { getTaskIntentClassifier } from "./task-intent.js";
import { KnowledgeService, type KnowledgeSearchResult } from "../knowledge.js";
import { resolveModel, getProvider } from "../../providers/registry.js";
import { settings } from "../../config.js";
import { ErrorCode } from "./errors/codes.js";

// ── 硬编码最终兜底文案 ──
const HARDCODED_FALLBACK =
  "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";

// ── ask_user 空 question 时的兜底提问文案 ──
const ASK_USER_FALLBACK = "请问您能提供更多信息吗？";

/** 工具名 → 过程时间轴的中文标签；未收录的工具回退为工具名本身 */
function toolTraceLabel(tool: string): string {
  if (tool === "search_knowledge_base") return "检索知识库";
  if (tool === "web_search") return "联网搜索";
  return tool;
}

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

// ── 执行状态（execute() 内部可变状态，在 extracted methods 间传递）──
interface ExecutionState {
  finalAnswer: string;
  suggestions: string[];
  accumulatedContent: string;
  collectedKBChunks: string[];
  lastKBToolResult: string | null;
  citationReport: CitationReport | null;
  phase: AgentPhase;
  outputState: OutputState;
  envelope: ResponseEnvelope;
  iterationCount: number;
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
      conversation_id: conversationId,
      session_id: sessionId,
      model: resolvedModel,
      provider: providerName,
      knowledge: [],
      intent,
      within_service_hours: withinServiceHours,
      memory_count: 0,
      route: "TASK",
    };

    // ── TASK 内部意图分类：simple_qa vs complex_task ──
    const taskIntent = await getTaskIntentClassifier().classify(userMessage, scope?.trace);
    logger.debug(
      { subclass: taskIntent.subclass, confidence: taskIntent.confidence },
      "TaskIntentClassifier result",
    );

    // ── 初始化可变状态 ──
    const state: ExecutionState = {
      finalAnswer: "",
      suggestions: [],
      accumulatedContent: "",
      collectedKBChunks: [],
      lastKBToolResult: null,
      citationReport: null,
      phase: "planning",
      outputState: {
        visibleChars: 0,
        responseStarted: false,
        responseCompleted: false,
      },
      envelope: {},
      iterationCount: 0,
    };

    try {
      // ── simple_qa 快速路径：单次 KB 搜索 + LLM 回答，跳过 ReAct ──
      if (taskIntent.subclass === "simple_qa") {
        yield* this.handleSimpleQA(
          context,
          scope,
          state.outputState,
          state.envelope,
          state.collectedKBChunks,
        );
        // 从 envelope 提取结果
        state.finalAnswer = state.envelope.finalContent || "";
        if (state.outputState.responseCompleted) {
          state.phase = "finished";
          state.outputState.responseStarted = true;
        }
      } else {
        // ── complex_task：完整 ReAct 循环 ──
        yield* this.handleComplexTask(context, scope, state);
      }

      // ── Interruption ──
      if (scope?.controller.shouldStop) {
        yield* this.handleInterruption(context, state);
        return;
      }

      // ── 安全网：检测并清除泄漏的 ReAct JSON ──
      if (state.finalAnswer) {
        const sanitized = sanitizeReActJSON(state.finalAnswer);
        if (sanitized === null) {
          logger.warn(
            { errorCode: ErrorCode.AE_REACT_JSON_LEAK, finalAnswer: state.finalAnswer.slice(0, 200) },
            "ReAct JSON leaked to final answer, using fallback",
          );
          state.envelope.finalContent = undefined;
          if (!state.envelope.fallbackContent) {
            state.envelope.fallbackContent =
              "抱歉，查询未找到结果。请检查您提供的信息是否正确，或联系人工客服获取帮助。";
          }
          state.suggestions = ["转接人工客服"];
        } else {
          state.envelope.finalContent = sanitized;
          state.finalAnswer = sanitized;
        }
      }

      // ── KnowledgeContext 构建：从 search_knowledge_base 工具结果提取结构化上下文 ──
      let knowledgeContext = null;
      if (state.lastKBToolResult && state.finalAnswer) {
        try {
          const kbBuilder = new KnowledgeContextBuilder();
          knowledgeContext = kbBuilder.build(state.lastKBToolResult, userMessage);
          if (knowledgeContext) {
            logger.debug(
              { confidence: knowledgeContext.confidence, docs: knowledgeContext.docs.length },
              "KnowledgeContext built from KB tool results",
            );
          }
        } catch (e) {
          logger.warn({ errorCode: ErrorCode.AE_KB_CONTEXT_FAILED, err: e }, "KnowledgeContext building skipped");
        }
      }

      // ── 引用卡片：complex_task 的检索发生在工具调用中，故卡片在回答流之后下发 ──
      if (knowledgeContext && knowledgeContext.citations.length > 0) {
        yield {
          type: "citations",
          items: toCitationCards(knowledgeContext.citations),
          message_id: assistantMsgId,
        };
      }

      // ── Citation 引证校验 ──
      if (state.finalAnswer && state.collectedKBChunks.length > 0) {
        try {
          const verifier = getCitationVerifier();
          state.citationReport = await verifier.verify(
            state.finalAnswer,
            state.collectedKBChunks,
          );
          agentCitationCoverage.observe(
            { level: state.citationReport.level },
            state.citationReport.coverageRate,
          );
        } catch (e) {
          logger.warn({ errorCode: ErrorCode.AE_CITATION_FAILED, err: e }, "Citation verification skipped");
        }
      }

      // ── 业务回复校验 ──
      if (state.finalAnswer) {
        const validationResult = validateBusinessResponse(
          state.finalAnswer,
          state.collectedKBChunks,
          state.citationReport ?? undefined,
        );
        if (!validationResult.valid) {
          logger.warn(
            { errorCode: ErrorCode.AE_VALIDATION_FAILED, errors: validationResult.errors, layer: validationResult.layer },
            "Business response validation failed",
          );
          // Layer 3（禁止行为）/ Layer 5（疑似编造）→ 追加免责声明
          if (validationResult.layer === 3 || validationResult.layer === 5) {
            state.finalAnswer +=
              "\n\n⚠ *以上信息可能不准确，建议核实后参考。*";
            state.envelope.finalContent = state.finalAnswer;
          }
        }
      }
    } catch (e) {
      logger.error({ errorCode: ErrorCode.AE_EXECUTION_FAILED, err: e }, "AgentExecutor execution failed");
      if (!state.envelope.fallbackContent) {
        state.envelope.fallbackContent = HARDCODED_FALLBACK;
      }
    }

    // ── Post-processing：唯一补偿出口 ──
    // 如果 agent_respond 未触发但 agent_responding 已流式输出了 token，
    // 且没有错误回退内容 → 标记为已完成，避免重复输出。
    // 如果有 fallbackContent（agent_error 触发），仍需补偿输出替换受损内容。
    if (!state.outputState.responseCompleted && state.outputState.responseStarted && state.outputState.visibleChars > 0 && !state.envelope.fallbackContent) {
      state.outputState.responseCompleted = true;
    }

    let fallbackUsed = false;
    if (!state.outputState.responseCompleted) {
      const resolved =
        state.envelope.finalContent ??
        state.envelope.fallbackContent ??
        sanitizeReActJSON(state.accumulatedContent);
      const content = resolved || HARDCODED_FALLBACK;

      fallbackUsed = content === HARDCODED_FALLBACK;

      for (const char of content) {
        yield {
          type: "token",
          content: char,
          message_id: assistantMsgId,
        };
        state.outputState.visibleChars++;
      }
      state.outputState.responseCompleted = true;
    }

    // V3.0: 记录对话到分层记忆系统（异步，不阻塞响应）
    if (state.finalAnswer && sessionId) {
      const recordMemory = async () => {
        try {
          const { getMemoryService } = await import("../memory-service.js");
          const memoryService = getMemoryService();
          const convId = conversationId || sessionId;
          await memoryService.recordExchange(convId, userMessage, state.finalAnswer!);
        } catch (e) {
          logger.warn({ errorCode: ErrorCode.AE_MEMORY_FAILED, err: e }, "Memory recording failed (non-blocking)");
        }
      };
      // Fire and forget — 不阻塞 done event
      recordMemory().catch(() => {
        // recordMemory 内部已 try/catch 并 logger.warn；
        // 此处捕获的是 dynamic import 或其他同步抛出的异常
        agentMemoryRecordFailures.inc({ reason: "unhandled_rejection" });
      });
    }

    // 发送 done
    yield {
      type: "done",
      message_id: assistantMsgId,
      usage: {},
      suggestions:
        state.suggestions.length > 0
          ? state.suggestions
          : fallbackUsed
            ? ["转接人工客服"]
            : undefined,
      memory: { injected: 0, extracted: 0 },
      validated: true,
      fallback_used: fallbackUsed || undefined,
      route: "TASK",
      citation: state.citationReport
        ? {
            level: state.citationReport.level,
            coverageRate: state.citationReport.coverageRate,
            avgScore: state.citationReport.avgScore,
            uncitedCount: state.citationReport.sentences.filter(
              (s) => s.isFactual && s.status === "uncited",
            ).length,
          }
        : undefined,
    };
  }

  // ═══════════════════════════════════════════════════════
  // handleComplexTask —— 完整 ReAct 循环
  // ═══════════════════════════════════════════════════════

  private async *handleComplexTask(
    context: RouteContext,
    scope: ExecutionScope | undefined,
    state: ExecutionState,
  ): AsyncGenerator<RouteStreamEvent> {
    const { conversationId, userMessage, assistantMsgId, resolvedModel } =
      context;

    const agentService = new AgentService();

    // ── 构建任务描述 ──
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
      skipAssistantMessageSave: true,
      guardConfig: {
        maxTokens: 2000,
        maxCostCents: 5,
      },
    });

    // 映射 agent 事件 → agent-runtime SSE 事件
    /** 过程时间轴序号：本方法内单调递增，保证每步独立 */
    let traceSeq = 0;
    for await (const event of events) {
      if (scope?.controller.shouldStop) break;

      switch (event.type) {
        case "agent_token":
          if ("content" in event) {
            const token = event.content as string;
            if (state.phase === "responding") {
              state.accumulatedContent += token;
              yield {
                type: "token",
                content: token,
                message_id: assistantMsgId,
              };
              state.outputState.visibleChars++;
            } else {
              state.accumulatedContent += token;
            }
          }
          break;

        case "agent_responding":
          state.phase = "responding";
          state.outputState.responseStarted = true;
          break;

        case "agent_clear_stream":
          state.accumulatedContent = "";
          yield {
            type: "clear_stream",
            message_id: assistantMsgId,
          };
          break;

        case "agent_observe": {
          state.phase = "observing";
          state.iterationCount++;
          const eventTool =
            "tool" in event && typeof event.tool === "string" ? event.tool : "";
          const resultStr =
            "result" in event && typeof event.result === "string"
              ? event.result
              : "";
          if (eventTool) {
            agentToolCallsTotal.inc({
              tool_name: eventTool,
              status: "success",
              route: "TASK",
            });
          }
          let hitCount: number | undefined;
          let isKbRetrieval = false;
          if (resultStr) {
            const kbChunks = extractKBChunks(resultStr);
            if (kbChunks.length > 0) {
              state.collectedKBChunks.push(...kbChunks);
              hitCount = kbChunks.length;
              // 保存最近一次 search_knowledge_base 的原始输出供 KnowledgeContext 构建
              if (isKnowledgeBaseResult(resultStr)) {
                state.lastKBToolResult = resultStr;
                isKbRetrieval = true;
              }
            } else if (/"found"\s*:/.test(resultStr)) {
              // KB 工具的输出必带 query/found 字段；命中为空时也要落一步，
              // 让用户看到"查了但没查到"，而不是这一步凭空消失
              isKbRetrieval = true;
              hitCount = 0;
            }
          }
          // agent_observe 不保证带 tool 字段（原生 tool-calling 只给 step/result，
          // 工具名写在 result 前缀 "Tool <name>: ..."）；取不到就退回通用标签，不臆造。
          const toolName =
            eventTool ||
            /^Tool\s+([A-Za-z0-9_]+)\s*:/.exec(resultStr.trim())?.[1] ||
            "";
          // 过程时间轴：每次工具观测一步，让用户看到 Agent 调了什么、拿到多少
          traceSeq += 1;
          yield {
            type: "trace_step",
            step: {
              seq: traceSeq,
              kind: isKbRetrieval ? "retrieval" : "tool",
              label: isKbRetrieval
                ? "检索知识库"
                : toolName
                  ? toolTraceLabel(toolName)
                  : "调用工具",
              status: "done",
              detail: toolName || undefined,
              hitCount,
            },
            message_id: assistantMsgId,
          };
          break;
        }

        case "agent_respond":
          if ("content" in event) {
            state.envelope.finalContent = event.content as string;
            state.finalAnswer = state.envelope.finalContent;

            if (!state.outputState.responseStarted) {
              for (const char of state.envelope.finalContent) {
                yield {
                  type: "token",
                  content: char,
                  message_id: assistantMsgId,
                };
                state.outputState.visibleChars++;
              }
              state.outputState.responseStarted = true;
            }
            state.outputState.responseCompleted = true;
          }
          break;

        case "agent_error":
          logger.warn(
            { errorCode: ErrorCode.AE_AGENT_ERROR, error: "error" in event ? event.error : "unknown" },
            "AgentExecutor agent error",
          );
          if (!state.envelope.fallbackContent) {
            state.envelope.fallbackContent = HARDCODED_FALLBACK;
          }
          break;

        case "agent_done":
          state.phase = "finished";
          break;

        // P0: agent_ask_user — Agent 需要向用户提问澄清。
        // 将 question 文本转换为 RouteStreamEvent token 流，避免
        // ReAct JSON 泄露到 fallback 路径。
        case "agent_ask_user": {
          const question = event.question;
          if (!question) {
            logger.warn(
              { errorCode: ErrorCode.AE_ASK_USER_EMPTY, eventType: "agent_ask_user", conversationId },
              "agent_ask_user event received with empty question, using fallback",
            );
          }
          // 向下游发送 clear_stream 信号，确保前端也清除残留 token
          yield {
            type: "clear_stream",
            message_id: assistantMsgId,
          };
          // 清除之前累积的 ReAct JSON token，确保 fallback 不使用脏数据
          state.accumulatedContent = "";
          state.phase = "responding";
          state.outputState.responseStarted = true;
          const displayText = question || ASK_USER_FALLBACK;
          for (const char of displayText) {
            yield {
              type: "token",
              content: char,
              message_id: assistantMsgId,
            };
            state.outputState.visibleChars++;
          }
          state.envelope.finalContent = displayText;
          state.outputState.responseCompleted = true;
          break;
        }

        // ── 显式未处理事件（AgentService 内部事件，不映射到 RouteStreamEvent）──
        // agent_think: Agent 推理步骤（observation/analysis/plan），开发调试用，
        //   通过 AgentPanel REST API 加载 scratchpad 查看，不需要在聊天流中展示。
        // agent_act: Agent 行动决策，仅用于 AgentPanel 展示 scratchpad。
        // agent_meta: AgentService 元信息（session_id/model/provider/tools_enabled），
        //   AgentExecutor 已在 L77-88 独立产出 meta 事件。
        // agent_approval_required: 工具审批请求，通过独立 API（POST /api/agent/approve）
        //   流程处理，不经过本路由的 SSE 流。
        // agent_approval_result: 审批结果通知，通过审批 API 自身 SSE 返回。
        // agent_degraded: LLM 降级通知，降级消息已注入 conversationMessages，
        //   无需额外前端事件。
        // agent_guard_block: 安全守卫拦截通知，阻塞消息已注入 conversationMessages。
        case "agent_think":
        case "agent_act":
        case "agent_meta":
        case "agent_approval_required":
        case "agent_approval_result":
        case "agent_degraded":
        case "agent_guard_block":
          break;

        default:
          // 未识别的 AgentStreamEvent 类型 — 记录警告以便发现未来新增事件的遗漏映射
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- exhaustive check makes event: never
          logger.warn(
            { errorCode: ErrorCode.AE_UNRECOGNIZED_EVENT, eventType: (event as any).type },
            "AgentExecutor received unrecognized AgentStreamEvent type",
          );
          break;
      }
    }

    // ReAct 迭代指标
    agentReActIterations.observe(
      { agent_type: "agent_executor" },
      state.iterationCount,
    );
  }

  // ═══════════════════════════════════════════════════════
  // handleInterruption —— 中断处理
  // ═══════════════════════════════════════════════════════

  private async *handleInterruption(
    context: RouteContext,
    state: ExecutionState,
  ): AsyncGenerator<RouteStreamEvent> {
    const { assistantMsgId, conversationId, resolvedModel } = context;

    // P0: Sanitize partial content before streaming.
    // accumulatedContent may contain raw ReAct JSON tokens from the
    // planning/executing phase that were never cleared by agent_clear_stream.
    // Without sanitization, cancelling during planning leaks internal JSON to users.
    const rawPartial =
      state.accumulatedContent || state.envelope.finalContent || "";
    const sanitizedPartial = sanitizeReActJSON(rawPartial);
    // sanitizeReActJSON returns null when content IS ReAct JSON but no
    // extractable text found — must NOT fall back to rawPartial (that
    // would leak internal JSON).  Only use rawPartial when the content
    // doesn't look like ReAct JSON at all (sanitizeReActJSON returns
    // the original string unchanged).
    const partialContent = sanitizedPartial ?? HARDCODED_FALLBACK;
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
          { errorCode: ErrorCode.AE_INTERRUPT_PERSIST_FAILED, error: err instanceof Error ? err.message : "Unknown error", conversationId },
          "Failed to persist partial agent-executor content on interrupt",
        );
      }

      // 仅在尚未流式输出时补偿输出（phase !== "responding" 时 token 仅缓存未发送）
      if (!state.outputState.responseStarted) {
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
  }

  /**
   * simple_qa 快速路径：单次 KB 搜索 + LLM 直接回答，跳过完整 ReAct 循环。
   *
   * 适用场景：单事实查询（"退换货条件是什么?"、"营业时间?"、"金卡会员有什么权益?"）
   * 延迟目标：1 次 embedding + 1 次 LLM 调用（vs ReAct 的 3-5 次 LLM 调用）
   *
   * 降级策略：KB 搜索失败 → 回退到通用 LLM 回答（标注无知识库支持）
   */
  private async *handleSimpleQA(
    context: RouteContext,
    scope: ExecutionScope | undefined,
    outputState: OutputState,
    envelope: ResponseEnvelope,
    collectedKBChunks: string[],
  ): AsyncGenerator<RouteStreamEvent> {
    const { userMessage, assistantMsgId, conversationId, sessionId } = context;

    // 1. 直接搜索知识库（单次调用，不走 ToolRegistry）
    // 过程时间轴：本轮只有一次检索，running 与 done/failed 共用 seq=1，前端按 seq 更新同一步
    const retrievalStep = (
      status: TraceStep["status"],
      hitCount?: number,
    ): TraceStep => ({
      seq: 1,
      kind: "retrieval",
      label: "检索知识库",
      status,
      detail: userMessage,
      hitCount,
    });

    yield {
      type: "trace_step",
      step: retrievalStep("running"),
      message_id: assistantMsgId,
    };

    let kbResults: string[] = [];
    /** 与 kbResults 同序同长：kbDocs[i] 对应下方 prompt 里的 [i+1] */
    let kbDocs: KnowledgeSearchResult[] = [];
    let kbFailed = false;
    try {
      const kbService = new KnowledgeService();
      // 保留完整结果（docTitle / score / docId / chunkIndex），供引用卡片使用
      const found = await kbService.searchWithRerank(userMessage, null, 5);
      // 过滤空正文，保证 kbDocs 与 kbResults 索引严格一致
      kbDocs = found.filter((r) => Boolean(r.content));
      kbResults = kbDocs.map((r) => r.content);
      if (kbResults.length > 0) {
        collectedKBChunks.push(...kbResults);
      }
    } catch (e) {
      kbFailed = true;
      logger.warn({ errorCode: ErrorCode.AE_SIMPLE_QA_KB_FAILED, err: e }, "simple_qa: KB search failed, proceeding without KB context");
    }

    yield {
      type: "trace_step",
      step: retrievalStep(kbFailed ? "failed" : "done", kbFailed ? undefined : kbDocs.length),
      message_id: assistantMsgId,
    };

    // 引用卡片：编号与下方 prompt 的 [n] 同源（均按 kbDocs 顺序），
    // 是否展示由前端在回答完成后按正文实际标注的 [n] 过滤
    if (kbDocs.length > 0) {
      yield {
        type: "citations",
        items: toCitationCards(
          kbDocs.map((r) => ({
            docId: r.docId,
            docTitle: r.docTitle,
            chunkIndex: r.chunkIndex,
            content: r.content,
            score: r.score,
            scoreType: r.scoreType,
            sourceScore: r.sourceScore,
            fusionScore: r.fusionScore,
            rerankScore: r.rerankScore,
          })),
        ),
        message_id: assistantMsgId,
      };
    }

    // 2. 构建简洁的 QA prompt（无 ReAct 结构）
    const kbContext = kbResults.length > 0
      ? `\n\n## 参考知识库\n${kbResults.map((c, i) => `[${i + 1}] ${c}`).join("\n\n")}\n\n请基于以上知识库内容回答。如果知识库没有相关信息，请如实说明。`
      : "\n\n（未找到相关知识库内容，请基于常识回答，并建议用户联系人工客服获取准确信息。）";

    const qaPrompt = `你是一个专业的客服助手。请用简洁、专业的语言回答用户问题。${
      kbResults.length > 0 ? "严格基于提供的知识库内容，不要编造。" : ""
    }

## 用户问题
${userMessage}
${kbContext}

## 回答要求
- 使用 Markdown 格式，适当使用列表或表格
- 如果知识库有相关信息，引用编号（如 [1]）
- 回答控制在 300 字以内`;

    // 3. 单次 LLM 调用（可配置更廉价模型）
    const { providerName, modelId: model } = resolveModel(
      settings.simpleQaModel || context.resolvedModel,
    );

    // ── Observability: LLM Generation ──
    const trace: ObservabilityTrace | undefined = scope?.trace;
    let lfGen = trace?.generation({
      name: "simple-qa-response",
      model,
      input: { userMessage, kbResultCount: kbResults.length },
      metadata: { provider: providerName },
    });

    try {
      const provider = getProvider(providerName);

      // 流式输出
      yield {
        type: "clear_stream",
        message_id: assistantMsgId,
      };

      outputState.responseStarted = true;

      const result = await provider.chatSync(
        [{ role: "user", content: qaPrompt }],
        model,
        undefined, // no system prompt override — qaPrompt is self-contained
        0.3,       // 低温度保证事实准确性
        800,       // 足够回答 300 字
        false,     // 不需要 jsonMode
      );

      const content = result.content || "";

      lfGen?.end({
        output: { answer: content.slice(0, 500) },
        usage: result.usage
          ? {
              promptTokens: result.usage.prompt_tokens,
              completionTokens: result.usage.completion_tokens,
              totalTokens:
                result.usage.prompt_tokens + result.usage.completion_tokens,
            }
          : undefined,
      });

      for (const char of content) {
        yield {
          type: "token",
          content: char,
          message_id: assistantMsgId,
        };
        outputState.visibleChars++;
      }

      envelope.finalContent = content;
      outputState.responseCompleted = true;

      // 持久化助手消息
      try {
        await prisma.message.create({
          data: {
            id: assistantMsgId,
            conversationId,
            role: "assistant",
            content,
            model,
          },
        });
      } catch (e) {
        logger.warn({ errorCode: ErrorCode.AE_SIMPLE_QA_PERSIST_FAILED, err: e }, "simple_qa: Failed to persist assistant message");
      }

      // 记忆记录由 execute() 尾部共享代码统一处理
    } catch (e) {
      logger.error({ errorCode: ErrorCode.AE_SIMPLE_QA_LLM_FAILED, err: e }, "simple_qa: LLM call failed");
      lfGen?.end({
        output: { error: "LLM call failed", reason: e instanceof Error ? e.message : "Unknown error" },
      });
      envelope.fallbackContent = HARDCODED_FALLBACK;
    }
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

// sanitizeReActJSON 和 looksLikeReActJSON 已提取到 ./react-json-utils.ts
// 避免与 ../agent.js 之间的循环依赖

/**
 * 检测工具输出是否为 search_knowledge_base 的返回结果。
 */
export function isKnowledgeBaseResult(toolResult: string): boolean {
  return toolResult.includes('"results"') && toolResult.includes('"found"');
}

/**
 * 从 search_knowledge_base 工具返回的 JSON 中提取 KB chunk 文本。
 */
export function extractKBChunks(toolResult: string): string[] {
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
