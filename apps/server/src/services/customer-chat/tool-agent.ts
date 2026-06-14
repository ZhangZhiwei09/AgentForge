// ToolAgent —— 客服工具调用
// 包装 AgentService.run() 的 ReAct 循环
// 将 agent SSE 事件映射到 customer-chat SSE 协议
// 启用客服工具集，限制 maxIterations: 5

import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import type { ContentBlock } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";
import {
  csReActIterations,
  csToolCallsTotal,
} from "../../observability/metrics.js";

// ── 默认客服工具集（Router 未推荐工具时使用） ──

const DEFAULT_CS_TOOLS = [
  "search_knowledge_base",
  "lookup_order",
  "create_support_ticket",
  "check_return_policy",
  "check_shipping_status",
  "get_current_time",
];

// ── Agent 业务阶段（由业务事件驱动，不由 token 驱动） ──
//
// planning   : 初始/思考中
// executing  : Agent 决定调用工具（agent_decide tool_call 或 native tool call）
// observing  : 工具返回结果，Agent 消化数据（agent_observe）
// responding : Agent 显式声明开始组织最终回复（agent_responding）
// finished   : 完整生命周期结束（agent_done）
type AgentPhase = "planning" | "executing" | "observing" | "responding" | "finished";

// ── 输出生命周期（只描述流式交付进度，与 Agent 业务阶段解耦） ──
//
// responseStarted   : agent_responding 已触发 → 开始交付最终答案
// responseCompleted : agent_respond 已触发 或 post-processing 已完成补偿
// visibleChars      : 已交付给用户的字符数，只增不减
interface OutputState {
  visibleChars: number;
  responseStarted: boolean;
  responseCompleted: boolean;
}

// ── 响应内容（分离正常内容和兜底内容，消除覆盖歧义） ──
interface ResponseEnvelope {
  finalContent?: string;     // 来自 agent_respond
  fallbackContent?: string;  // 来自 agent_error / sanitize 失败
}

// ═══════════════════════════════════════════════════════
// ToolAgent
// ═══════════════════════════════════════════════════════

export class ToolAgent implements RouteAgent {
  readonly route = "TOOL" as const;

  async *execute(context: RouteContext): AsyncGenerator<RouteStreamEvent> {
    const {
      conversationId,
      sessionId,
      userMessage,
      resolvedModel,
      providerName,
      withinServiceHours,
      assistantMsgId,
      intent,
      toolHints,
      executionHint,
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
      route: "TOOL",
    };

    let finalAnswer = "";
    let suggestions: string[] = [];
    const contentBlocks: ContentBlock[] = [];
    let accumulatedContent = "";

    // ── 解耦的状态机 ──
    let phase: AgentPhase = "planning";
    const outputState: OutputState = {
      visibleChars: 0,
      responseStarted: false,
      responseCompleted: false,
    };
    const envelope: ResponseEnvelope = {};
    let iterationCount = 0; // ReAct 迭代计数（用于指标埋点）

    try {
      // 动态导入 AgentService（避免循环依赖）
      const { AgentService } = await import("../agent.js");

      const agentService = new AgentService();

      // ── 工具列表：Router 推荐优先，为空时使用默认全量工具集 ──
      // 始终追加 search_knowledge_base 作为兜底（Router 可能漏推荐 KB 检索）
      const rawHints = toolHints && toolHints.length > 0 ? toolHints : DEFAULT_CS_TOOLS;
      const enabledTools = rawHints.includes("search_knowledge_base")
        ? rawHints
        : [...rawHints, "search_knowledge_base"];

      // 构建客服任务描述（含执行策略提示）
      const hintsBlock =
        toolHints && toolHints.length > 0
          ? `\n\n[系统提示] 本场景推荐使用以下工具：${toolHints.join("、")}。建议${executionHint === "sequential" ? "按顺序" : "可并行"}执行。你可根据实际情况调整。`
          : "";

      const task = `用户询问：${userMessage}${hintsBlock}

请使用可用工具帮助用户解决问题。回答要简洁、专业、友好。
如果工具返回了数据，请直接用自然语言 + Markdown 表格或列表向用户解释结果。
不要输出 \`\`\`card:xxx 围栏代码块，系统会自动处理结构化数据展示。`;

      // 运行 Agent ReAct 循环（使用 Router 推荐的工具列表）
      const events = agentService.run(conversationId, task, {
        model: resolvedModel,
        maxIterations: 5,
        tools: enabledTools,
        guardConfig: {
          maxTokens: 2000,
          maxCostCents: 5, // $0.05
        },
      });

      // 映射 agent 事件 → customer-chat SSE 事件
      //
      // 核心原则：
      // - Phase 由业务事件驱动（agent_observe/agent_responding/agent_respond/agent_done）
      // - OutputState 独立维护响应交付进度
      // - agent_token 仅做输出转发，不驱动任何状态转换

      for await (const event of events) {
        switch (event.type) {
          // ── Token 输出 ──
          case "agent_token":
            if ("content" in event) {
              const token = event.content as string;
              if (phase === "responding") {
                // Agent 已声明开始回复 → 实时流式转发
                accumulatedContent += token;
                yield {
                  type: "token",
                  content: token,
                  message_id: assistantMsgId,
                };
                outputState.visibleChars++;
              } else {
                // 非 responding 阶段：仅缓存（可能是前置废话或 JSON 决策文本）
                accumulatedContent += token;
              }
            }
            break;

          // ── Agent 声明开始组织最终回复 ──
          case "agent_responding":
            phase = "responding";
            outputState.responseStarted = true;
            break;

          // ── 流式内容清空（清的是非最终内容：JSON/前言/重试前文本） ──
          case "agent_clear_stream":
            accumulatedContent = "";
            // visibleChars 不重置：用户看到的事实不可撤销
            // responseStarted 不重置：agent_responding 已声明回复意图
            break;

          // ── 工具执行完毕 ──
          case "agent_observe":
            phase = "observing";
            iterationCount++;
            // 客服工具调用指标埋点
            if ("tool" in event && event.tool) {
              csToolCallsTotal.inc({
                tool_name: String(event.tool),
                status: "success",
                route: "TOOL",
              });
            }
            if ("result" in event && event.result) {
              const card = tryExtractCard(event.result as string);
              if (card) {
                contentBlocks.push(card);
              }
            }
            break;

          // ── 最终回复已生成 ──
          case "agent_respond":
            if ("content" in event) {
              envelope.finalContent = event.content as string;
              finalAnswer = envelope.finalContent;

              // 如果内容尚未通过流式交付（如 agent_decide respond 路径）
              // → 立即补偿输出
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

          // ── 错误处理（不改变 phase） ──
          case "agent_error":
            logger.warn(
              { error: "error" in event ? event.error : "unknown" },
              "ToolAgent agent error",
            );
            // fallbackContent 不覆盖已有的值
            if (!envelope.fallbackContent) {
              envelope.fallbackContent =
                "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";
            }
            break;

          // ── Agent 生命周期结束 ──
          case "agent_done":
            phase = "finished";
            break;

          default:
            break;
        }
      }

      // ── ReAct 迭代指标埋点 ──
      csReActIterations.observe(
        { agent_type: "tool_agent" },
        iterationCount,
      );

      // ── 安全网：检测并清除泄漏的 ReAct JSON ──
      if (finalAnswer) {
        const sanitized = sanitizeReActJSON(finalAnswer);
        if (sanitized === null) {
          // 检测到无法提取内容的 ReAct JSON，使用兜底文案
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
    } catch (e) {
      logger.error(e, "ToolAgent execution failed");
      if (!envelope.fallbackContent) {
        envelope.fallbackContent =
          "抱歉，系统暂时无法处理您的请求，请稍后再试或联系人工客服。";
      }
    }

    // ── 先发送 content_block（卡片），前端接收后立即渲染 ──
    for (const block of contentBlocks) {
      yield {
        type: "content_block",
        block,
        message_id: assistantMsgId,
      };
    }

    // ── Post-processing：唯一补偿出口 ──
    // 判断依据：最终回复是否已完成交付（不依赖 phase，不依赖 flowState）
    if (!outputState.responseCompleted) {
      const content =
        envelope.finalContent
        ?? envelope.fallbackContent
        ?? sanitizeReActJSON(accumulatedContent)
        ?? "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";

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
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      memory: { injected: 0, extracted: 0 },
      validated: true,
      route: "TOOL",
    };
  }
}

// ═══════════════════════════════════════════════════════
// 卡片提取工具函数
// ═══════════════════════════════════════════════════════

/**
 * 尝试从工具执行结果中提取结构化卡片
 * 目前支持：lookup_order → OrderCard, check_shipping_status → StatusCard
 */
function tryExtractCard(result: string): ContentBlock | null {
  try {
    // 尝试解析 JSON（工具结果可能是 JSON 字符串）
    const data = JSON.parse(result.trim());

    // 规范化字段：同时支持 camelCase 和 snake_case
    const norm = {
      orderId: data.orderId ?? data.order_id,
      status: data.status ?? data.current_status,
      statusLabel: data.statusLabel ?? data.status_label,
      items: data.items,
      total: data.total,
      carrier: data.carrier,
      trackingNo: data.trackingNo ?? data.tracking_no,
      estimatedDelivery: data.estimatedDelivery ?? data.estimated_delivery,
      createdAt: data.createdAt ?? data.created_at,
      history: data.history,
      category: data.category,
      policy: data.policy,
      conditions: data.conditions,
      title: data.title ?? data.policy,
      refundTimeline: data.refundTimeline ?? data.refund_timeline,
      returnWindow: data.returnWindow ?? data.return_window,
      exceptions: data.exceptions,
      // 支付和物流嵌套字段
      payment: data.payment,
      shipping: data.shipping,
    };

    // lookup_order 结果 → OrderCard
    if (norm.orderId && norm.status) {
      // 总计优先从 payment.total 提取（snake_case 工具输出），fallback 到顶层
      const total = Number(norm.payment?.total ?? norm.total ?? 0);
      // carrier/trackingNo 优先从 shipping 嵌套提取
      const carrier =
        (norm.shipping?.carrier as string) || norm.carrier || undefined;
      const trackingNo =
        (norm.shipping?.tracking_no as string) ||
        (norm.shipping?.trackingNo as string) ||
        norm.trackingNo ||
        undefined;
      const estimatedDelivery =
        (norm.shipping?.estimated_delivery as string) ||
        (norm.shipping?.estimatedDelivery as string) ||
        norm.estimatedDelivery ||
        undefined;

      return {
        type: "order_card",
        data: {
          orderId: String(norm.orderId),
          status: String(norm.status),
          statusLabel: String(norm.statusLabel ?? norm.status),
          items: (norm.items ?? []).map((item: Record<string, unknown>) => ({
            name: String(item.name ?? ""),
            quantity: Number(item.quantity ?? 1),
            price: Number(item.unit_price ?? item.unitPrice ?? item.price ?? 0),
          })),
          total,
          carrier,
          trackingNo,
          estimatedDelivery,
          createdAt: String(norm.createdAt ?? ""),
        },
      };
    }

    // check_shipping_status 结果 → StatusCard
    if (norm.trackingNo || (norm.carrier && norm.status)) {
      const steps = Array.isArray(norm.history)
        ? norm.history.map(
            (h: Record<string, unknown>, i: number, arr: unknown[]) => ({
              label: String(h.status ?? h.description ?? ""),
              status:
                i === arr.length - 1 ? ("active" as const) : ("done" as const),
              description: `${h.time ?? ""} ${h.location ?? ""}`,
            }),
          )
        : undefined;

      return {
        type: "status_card",
        data: {
          title: `物流追踪 · ${norm.trackingNo ?? norm.carrier ?? ""}`,
          status: "in_progress",
          steps,
          message: String(norm.statusLabel ?? norm.status ?? ""),
        },
      };
    }

    // check_return_policy 结果 → PolicyCard
    if (norm.category || norm.policy || norm.conditions) {
      return {
        type: "policy_card",
        data: {
          category: String(norm.category ?? "退换货政策"),
          title: String(norm.title ?? ""),
          conditions: Array.isArray(norm.conditions)
            ? norm.conditions.map(String)
            : [],
          refundTimeline: norm.refundTimeline as string | undefined,
          returnWindow: norm.returnWindow as string | undefined,
          exceptions: Array.isArray(norm.exceptions)
            ? norm.exceptions.map(String)
            : undefined,
        },
      };
    }
  } catch {
    // 不是 JSON → 不是结构化数据，跳过
  }
  return null;
}

/**
 * 检测并清理 ReAct Agent 内部 JSON 输出（防止泄漏到用户界面）
 * 如果检测到原始 ReAct JSON 格式，尝试提取其中的用户回复内容；
 * 如果无法提取，返回 null 以便调用方使用统一兜底文案。
 */
function sanitizeReActJSON(text: string): string | null {
  const trimmed = text.trim();

  // 检测特征：以 { 开头，且包含 observation/analysis/plan 三个关键 JSON 字段
  const looksLikeReActJSON =
    trimmed.startsWith("{") &&
    /"observation"\s*:/.test(trimmed) &&
    /"analysis"\s*:/.test(trimmed) &&
    /"plan"\s*:/.test(trimmed);

  if (!looksLikeReActJSON) return text; // 正常内容，原样返回

  // 尝试提取 decision.content（用户回复）
  try {
    const parsed = JSON.parse(trimmed);
    const decision = parsed.decision;

    // 情况1：decision 是对象，有 content 字段
    if (typeof decision === "object" && decision?.content) {
      return String(decision.content);
    }

    // 情况2：decision 是 "respond" 字符串 —— LLM 未生成具体回复
    // 返回 null，调用方使用兜底文案
    if (typeof decision === "string") {
      return null;
    }

    // 情况3：尝试从顶层 content 或 summary 提取
    if (parsed.content && typeof parsed.content === "string") {
      return parsed.content;
    }
    if (parsed.summary && typeof parsed.summary === "string") {
      return parsed.summary;
    }

    return null;
  } catch {
    // JSON 解析失败——说明是半成品输出，返回 null
    return null;
  }
}
