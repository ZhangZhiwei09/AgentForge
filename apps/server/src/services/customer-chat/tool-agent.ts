// ToolAgent —— 客服工具调用
// 包装 AgentService.run() 的 ReAct 循环
// 将 agent SSE 事件映射到 customer-chat SSE 协议
// 启用客服工具集，限制 maxIterations: 5

import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import type { ContentBlock } from "@agentforge/shared-types";
import { logger } from "@agentforge/logger";

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
    let pastTools = false; // set true after first tool call — switches to real streaming

    try {
      // 动态导入 AgentService（避免循环依赖）
      const { AgentService } = await import("../agent.js");

      const agentService = new AgentService();

      // 构建客服任务描述（含 Intent Classifier 的工具推荐 + 执行策略）
      const hintsBlock =
        toolHints && toolHints.length > 0
          ? `\n\n[系统提示] Intent Classifier 推荐使用以下工具：${toolHints.join("、")}。建议${executionHint === "sequential" ? "按顺序" : "可并行"}执行。你可根据实际情况调整。`
          : "";

      const task = `用户询问：${userMessage}${hintsBlock}

请使用可用工具帮助用户解决问题。回答要简洁、专业、友好。
如果工具返回了数据，请直接用自然语言 + Markdown 表格或列表向用户解释结果。
不要输出 \`\`\`card:xxx 围栏代码块，系统会自动处理结构化数据展示。`;

      // 运行 Agent ReAct 循环（限制迭代次数 + 客服工具集）
      const events = agentService.run(conversationId, task, {
        model: resolvedModel,
        maxIterations: 5,
        tools: [
          "search_knowledge_base",
          "lookup_order",
          "create_support_ticket",
          "check_return_policy",
          "check_shipping_status",
          "get_current_time",
        ],
        guardConfig: {
          maxTokens: 2000,
          maxCostCents: 5, // $0.05
        },
      });

      // 映射 agent 事件 → customer-chat SSE 事件
      //
      // 流式策略：
      // - 工具调用前：agent_token 缓存（前置废话，等工具调用时清掉）
      // - 工具调用后：agent.ts 切换到 respond-only 模式，LLM 直接输出纯 Markdown
      //   → agent_token 直接转发给前端，利用 LLM 原生网络延迟实现真打字机

      for await (const event of events) {
        switch (event.type) {
          case "agent_token":
            if ("content" in event) {
              const token = event.content as string;
              if (pastTools) {
                // respond-only 阶段：LLM 输出的是纯 Markdown，直接转发
                accumulatedContent += token;
                yield {
                  type: "token",
                  content: token,
                  message_id: assistantMsgId,
                };
              } else {
                // 工具调用前：缓存（可能是前置废话或 JSON 决策文本）
                accumulatedContent += token;
              }
            }
            break;

          case "agent_clear_stream":
            accumulatedContent = "";
            pastTools = true;
            break;

          case "agent_observe":
            // 工具执行完毕 → 后续 LLM token 是纯 Markdown，开始转发
            pastTools = true;
            if ("result" in event && event.result) {
              const card = tryExtractCard(event.result as string);
              if (card) {
                contentBlocks.push(card);
              }
            }
            break;

          case "agent_respond":
            if ("content" in event) {
              finalAnswer = event.content as string;
            }
            break;

          case "agent_error":
            logger.warn(
              { error: "error" in event ? event.error : "unknown" },
              "ToolAgent agent error",
            );
            if (!finalAnswer) {
              finalAnswer =
                "抱歉，暂时无法处理您的请求，请稍后再试或联系人工客服。";
            }
            break;

          case "agent_done":
            break;

          default:
            break;
        }
      }

      if (!finalAnswer && accumulatedContent) {
        finalAnswer = accumulatedContent;
      }

      // ── 安全网：检测并清除泄漏的 ReAct JSON ──
      if (finalAnswer) {
        const sanitized = sanitizeReActJSON(finalAnswer);
        if (sanitized === null) {
          // 检测到无法提取内容的 ReAct JSON，使用兜底文案
          logger.warn(
            { finalAnswer: finalAnswer.slice(0, 200) },
            "ReAct JSON leaked to final answer, using fallback",
          );
          finalAnswer =
            "抱歉，查询未找到结果。请检查您提供的信息是否正确，或联系人工客服获取帮助。";
          suggestions = ["转接人工客服"];
        } else {
          finalAnswer = sanitized;
        }
      }

      if (!finalAnswer) {
        finalAnswer =
          "抱歉，暂时无法处理您的请求。请尝试重新描述您的问题，或转接人工客服获取帮助。";
        suggestions = ["转接人工客服"];
      }
    } catch (e) {
      logger.error(e, "ToolAgent execution failed");
      finalAnswer =
        "抱歉，系统暂时无法处理您的请求，请稍后再试或联系人工客服。";
    }

    // ── 先发送 content_block（卡片），前端接收后立即渲染 ──
    for (const block of contentBlocks) {
      yield {
        type: "content_block",
        block,
        message_id: assistantMsgId,
      };
    }

    // ── 补充输出：如果 agent_respond 有尚未流式发送的内容，补齐 ──
    // 正常情况（respond-only 路径）下 token 已全部实时转发，此处无需额外输出
    if (finalAnswer && !pastTools) {
      // fallback: agent 没有进入 respond-only 模式（如纯 agent_respond 路径）
      // 此时 accumulatedContent 可能包含 JSON 文本，优先使用 finalAnswer
      const cleaned = cleanRepeatedAnswer(finalAnswer);
      if (cleaned && cleaned !== accumulatedContent) {
        for (const char of cleaned) {
          yield {
            type: "token",
            content: char,
            message_id: assistantMsgId,
          };
        }
      }
    } else if (!finalAnswer && accumulatedContent && !pastTools) {
      // 最后的兜底：没有任何 respond，输出缓存
      for (const char of accumulatedContent) {
        yield {
          type: "token",
          content: char,
          message_id: assistantMsgId,
        };
      }
    }
    // pastTools=true 时 token 已实时转发，无需额外输出

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

  // 检测特征：以 { 开头，且包含 observation/analysis/plan 三个关键字段
  const looksLikeReActJSON =
    trimmed.startsWith("{") &&
    /\b"observation"\s*:/.test(trimmed) &&
    /\b"analysis"\s*:/.test(trimmed) &&
    /\b"plan"\s*:/.test(trimmed);

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

/**
 * 将 ContentBlock 转换为 Markdown fenced code block（向后兼容）
 */
/**
 * 清理 agent 回答中的重复文本（如开头重复的问候语）
 */
function cleanRepeatedAnswer(text: string): string {
  // 检测前一半和后一半是否重复
  const halfLen = Math.floor(text.length / 2);
  const firstHalf = text.slice(0, halfLen).trim();
  const secondHalf = text.slice(halfLen).trim();

  // 如果两半基本相同，去掉后半段
  if (firstHalf && secondHalf && firstHalf === secondHalf) {
    return firstHalf;
  }

  // 检测句子级重复：如果前两句相同
  const sentences = text.split(/(?<=[。！？\.\!\?])/);
  if (sentences.length >= 4) {
    const deduped: string[] = [];
    for (const s of sentences) {
      const trimmed = s.trim();
      if (trimmed && deduped[deduped.length - 1] === trimmed) {
        continue; // 跳过连续重复的句子
      }
      deduped.push(trimmed);
    }
    return deduped.join("");
  }

  return text;
}

/**
 * 将 ContentBlock 转换为 Markdown fenced code block（向后兼容）
 * 仅在没有 content_block SSE 事件的旧客户端中使用
 */
function buildCardFence(block: ContentBlock): string | null {
  let fenceType: string;
  let data: unknown;

  switch (block.type) {
    case "order_card":
      fenceType = "order";
      data = block.data;
      break;
    case "policy_card":
      fenceType = "policy";
      data = block.data;
      break;
    case "status_card":
      fenceType = "status";
      data = block.data;
      break;
    case "action_card":
      fenceType = "action";
      data = block.data;
      break;
    case "table":
      fenceType = "table";
      data = block.data;
      break;
    default:
      return null;
  }

  return (
    "```card:" + fenceType + "\n" + JSON.stringify(data, null, 2) + "\n```"
  );
}
