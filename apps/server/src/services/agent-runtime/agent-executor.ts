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
import { sanitizeReActJSON } from "./react-json-utils.js";
import type { CitationReport } from "./citation-verifier.js";
import { getCitationVerifier } from "./citation-verifier.js";
import { validateBusinessResponse } from "./validation.js";
import { KnowledgeContextBuilder } from "./knowledge-context.js";
import { toolRegistry } from "../../tools/registry.js";
import { getTaskIntentClassifier } from "./task-intent.js";
import { KnowledgeService } from "../knowledge.js";
import { resolveModel, getProvider } from "../../providers/registry.js";
import { settings } from "../../config.js";

// ── 硬编码最终兜底文案 ──
const HARDCODED_FALLBACK =
  "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";

// ── ask_user 空 question 时的兜底提问文案 ──
const ASK_USER_FALLBACK = "请问您能提供更多信息吗？";

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

    // ── TASK 内部意图分类：simple_qa vs complex_task ──
    const taskIntent = await getTaskIntentClassifier().classify(userMessage);
    logger.debug(
      { subclass: taskIntent.subclass, confidence: taskIntent.confidence },
      "TaskIntentClassifier result",
    );

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
      // ── simple_qa 快速路径：单次 KB 搜索 + LLM 回答，跳过 ReAct ──
      if (taskIntent.subclass === "simple_qa") {
        yield* this.handleSimpleQA(
          context,
          scope,
          outputState,
          envelope,
          collectedKBChunks,
        );
        // 从 envelope 提取结果
        finalAnswer = envelope.finalContent || "";
        if (outputState.responseCompleted) {
          phase = "finished";
          outputState.responseStarted = true;
        }
      } else {
        // ── complex_task：完整 ReAct 循环 ──
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

          // P0: agent_ask_user — Agent 需要向用户提问澄清。
          // 将 question 文本转换为 RouteStreamEvent token 流，避免
          // ReAct JSON 泄露到 fallback 路径。
          case "agent_ask_user": {
            const question = event.question;
            if (!question) {
              logger.warn(
                { eventType: "agent_ask_user", conversationId },
                "agent_ask_user event received with empty question, using fallback",
              );
            }
            // 向下游发送 clear_stream 信号，确保前端也清除残留 token
            yield {
              type: "clear_stream",
              message_id: assistantMsgId,
            };
            // 清除之前累积的 ReAct JSON token，确保 fallback 不使用脏数据
            accumulatedContent = "";
            phase = "responding";
            outputState.responseStarted = true;
            const displayText = question || ASK_USER_FALLBACK;
            for (const char of displayText) {
              yield {
                type: "token",
                content: char,
                message_id: assistantMsgId,
              };
              outputState.visibleChars++;
            }
            envelope.finalContent = displayText;
            outputState.responseCompleted = true;
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
              { eventType: (event as any).type },
              "AgentExecutor received unrecognized AgentStreamEvent type",
            );
            break;
        }
      }

      // ReAct 迭代指标
      agentReActIterations.observe(
        { agent_type: "agent_executor" },
        iterationCount,
      );
      } // ── end complex_task ReAct 分支 ──

      // ── Interruption ──
      if (scope?.controller.shouldStop) {
        // P0: Sanitize partial content before streaming.
        // accumulatedContent may contain raw ReAct JSON tokens from the
        // planning/executing phase that were never cleared by agent_clear_stream.
        // Without sanitization, cancelling during planning leaks internal JSON to users.
        const rawPartial = accumulatedContent || envelope.finalContent || "";
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

    // V3.0: 记录对话到分层记忆系统（异步，不阻塞响应）
    if (finalAnswer && sessionId) {
      const recordMemory = async () => {
        try {
          const { getMemoryService } = await import("../memory-service.js");
          const memoryService = getMemoryService();
          const convId = conversationId || sessionId;
          await memoryService.recordExchange(convId, userMessage, finalAnswer!);
        } catch (e) {
          logger.warn(e, "Memory recording failed (non-blocking)");
        }
      };
      // Fire and forget — 不阻塞 done event
      recordMemory();
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
    let kbResults: string[] = [];
    try {
      const kbService = new KnowledgeService();
      const searchResults = await kbService.search(userMessage, null, 5);
      kbResults = searchResults.map((r) => r.content).filter(Boolean);
      if (kbResults.length > 0) {
        collectedKBChunks.push(...kbResults);
      }
    } catch (e) {
      logger.warn(e, "simple_qa: KB search failed, proceeding without KB context");
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
    const [providerName, model] = resolveModel(
      settings.simpleQaModel || context.resolvedModel,
    );

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
        logger.warn(e, "simple_qa: Failed to persist assistant message");
      }

      // 记忆记录由 execute() 尾部共享代码统一处理
    } catch (e) {
      logger.error(e, "simple_qa: LLM call failed");
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
