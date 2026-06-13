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

    try {
      // 动态导入 AgentService（避免循环依赖）
      const { AgentService } = await import("../agent.js");

      const agentService = new AgentService();

      // 构建客服任务描述
      const task = `用户询问：${userMessage}\n\n请使用可用工具帮助用户解决问题。回答要简洁、专业、友好。如果工具返回了数据，请用自然语言向用户解释结果。`;

      // 运行 Agent ReAct 循环（限制迭代次数 + 客服工具集）
      const events = agentService.run(conversationId, task, {
        model: resolvedModel,
        maxIterations: 5,
        tools: [
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

      for await (const event of events) {
        switch (event.type) {
          case "agent_token":
            if ("content" in event) {
              accumulatedContent += event.content;
            }
            break;

          case "agent_respond":
            if ("content" in event) {
              finalAnswer = event.content as string;
            }
            break;

          case "agent_observe":
            // 尝试从工具结果中提取结构化卡片数据
            if ("result" in event && event.result) {
              const card = tryExtractCard(event.result as string);
              if (card) {
                contentBlocks.push(card);
              }
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

      // 如果 Agent 没有通过 agent_respond 设置答案，使用累积内容
      if (!finalAnswer && accumulatedContent) {
        finalAnswer = accumulatedContent;
      }

      // 如果仍然没有答案
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

    // ── 发送 content_block 事件（在文本 token 之前） ──
    for (const block of contentBlocks) {
      yield {
        type: "content_block",
        block,
        message_id: assistantMsgId,
      };
    }

    // ── 向后兼容：如果通过 content_block 发送了卡片，不再在文本中追加 fence（避免前端双重渲染） ──
    // ── 如果 content_block 未发送（旧客户端），卡片数据已在 finalAnswer 中（由 Agent LLM 生成 fence） ──
    let answerText = finalAnswer;
    if (contentBlocks.length === 0) {
      // 没有 content_block 事件 → 卡片信息只能通过文本 fence 传递
      // 但 ToolAgent 已通过 content_block 发送，此处无需追加
    }

    // 清理重复前缀：agent 有时会在部分 token 流之后在 agent_respond 中重复开头
    // 如果 finalAnswer 和 accumulatedContent 有共同前缀，使用较完整的版本
    if (finalAnswer && accumulatedContent) {
      // 使用 finalAnswer（agent_respond 通常是完整的最终回答）
      // 但需要清理可能的重复
      answerText = cleanRepeatedAnswer(finalAnswer);
    } else if (!answerText && accumulatedContent) {
      answerText = accumulatedContent;
    }

    // 逐字符流式输出最终答案
    for (const char of answerText) {
      yield {
        type: "token",
        content: char,
        message_id: assistantMsgId,
      };
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

    // lookup_order 结果 → OrderCard
    if (data.orderId && data.status) {
      return {
        type: "order_card",
        data: {
          orderId: data.orderId,
          status: data.status,
          statusLabel: data.statusLabel ?? data.status,
          items: (data.items ?? []).map((item: Record<string, unknown>) => ({
            name: String(item.name ?? ""),
            quantity: Number(item.quantity ?? 1),
            price: Number(item.unitPrice ?? item.price ?? 0),
          })),
          total: Number(data.total ?? 0),
          carrier: data.carrier as string | undefined,
          trackingNo: data.trackingNo as string | undefined,
          estimatedDelivery: data.estimatedDelivery as string | undefined,
          createdAt: String(data.createdAt ?? data.created_at ?? ""),
        },
      };
    }

    // check_shipping_status 结果 → StatusCard
    if (data.trackingNo || (data.carrier && data.status)) {
      const steps = Array.isArray(data.history)
        ? data.history.map((h: Record<string, unknown>, i: number, arr: unknown[]) => ({
            label: String(h.status ?? h.description ?? ""),
            status:
              i === arr.length - 1
                ? ("active" as const)
                : ("done" as const),
            description: `${h.time ?? ""} ${h.location ?? ""}`,
          }))
        : undefined;

      return {
        type: "status_card",
        data: {
          title: `物流追踪 · ${data.trackingNo ?? data.carrier ?? ""}`,
          status: "in_progress",
          steps,
          message: data.statusLabel ?? data.status ?? "",
        },
      };
    }

    // check_return_policy 结果 → PolicyCard
    if (data.category || data.policy || data.conditions) {
      return {
        type: "policy_card",
        data: {
          category: String(data.category ?? "退换货政策"),
          title: String(data.title ?? data.policy ?? ""),
          conditions: Array.isArray(data.conditions)
            ? data.conditions.map(String)
            : [],
          refundTimeline: data.refundTimeline as string | undefined,
          returnWindow: data.returnWindow as string | undefined,
          exceptions: Array.isArray(data.exceptions)
            ? data.exceptions.map(String)
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

  return "```card:" + fenceType + "\n" + JSON.stringify(data, null, 2) + "\n```";
}
