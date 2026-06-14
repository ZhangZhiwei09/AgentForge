// HumanAgent —— 人工转接处理
// 在 Router 分类为 HUMAN 或用户明确要求转人工时执行
// 更新会话状态 + 返回转接消息

import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import { streamTokens } from "./types.js";
import { logger } from "@agentforge/logger";
import { prisma } from "../../db.js";

// ── 转接话术 ──

function getHandoffMessage(
  withinServiceHours: boolean,
  escalationReason?: string,
): string {
  if (withinServiceHours) {
    return `正在为您转接人工客服，请稍候...

您的会话摘要已发送给客服人员，他们会很快接入。如需提前准备，您可以整理一下问题详情。`;
  }
  return `当前为非工作时间（工作日 9:00-18:00），人工客服暂时不在线。

您的问题已记录，我们会在下一个工作日尽快回复您。如有紧急问题，请拨打客服热线：400-XXX-XXXX。`;
}

// ═══════════════════════════════════════════════════════
// HumanAgent
// ═══════════════════════════════════════════════════════

export class HumanAgent implements RouteAgent {
  readonly route = "HUMAN" as const;

  async *execute(context: RouteContext): AsyncGenerator<RouteStreamEvent> {
    const {
      conversationId,
      sessionId,
      assistantMsgId,
      withinServiceHours,
      resolvedModel,
      providerName,
      intent,
    } = context;

    // 更新会话状态为 escalated
    try {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { status: "escalated" },
      });
    } catch (e) {
      logger.warn(e, "Failed to update conversation status to escalated");
    }

    // 日志记录升级事件
    logger.info(
      {
        conversationId,
        sessionId,
        withinServiceHours,
        reason: "HUMAN_ROUTE_TRIGGERED",
      },
      "HumanAgent escalating to human support",
    );

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
      route: "HUMAN",
    };

    // 流式输出转接消息
    const message = getHandoffMessage(withinServiceHours);
    yield* streamTokens(message, assistantMsgId);

    // 发送 done
    yield {
      type: "done",
      message_id: assistantMsgId,
      usage: {},
      suggestions: ["继续咨询其他问题", "关闭会话"],
      memory: { injected: 0, extracted: 0 },
      validated: true,
      route: "HUMAN",
    };
  }
}
