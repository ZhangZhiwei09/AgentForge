// SafetyAgent —— 拒绝安全违规消息
// 在 Router 分类为 SAFETY 后执行
// 返回确定性拒绝消息（不调 LLM，零延迟）

import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import type { ExecutionScope } from "../../runtime/scope.js";
import { streamTokens } from "./types.js";
import { logger } from "@agentforge/logger";

const SAFETY_REJECT_MESSAGE =
  "抱歉，您的消息包含不安全的请求内容，无法处理。如有实际业务问题，欢迎重新描述。";

export class SafetyAgent implements RouteAgent {
  readonly route = "SAFETY" as const;

  async *execute(
    context: RouteContext,
    _scope?: ExecutionScope,
  ): AsyncGenerator<RouteStreamEvent> {
    // 发送 meta
    yield {
      type: "meta",
      message_id: context.assistantMsgId,
      session_id: context.sessionId,
      model: context.resolvedModel,
      provider: context.providerName,
      knowledge: [],
      intent: context.intent,
      within_service_hours: context.withinServiceHours,
      memory_count: 0,
      route: "SAFETY",
    };

    // 逐字符流式输出拒绝消息
    yield* streamTokens(SAFETY_REJECT_MESSAGE, context.assistantMsgId);

    // 发送 done
    yield {
      type: "done",
      message_id: context.assistantMsgId,
      usage: {},
      suggestions: [],
      memory: { injected: 0, extracted: 0 },
      validated: true,
      route: "SAFETY",
    };

    // 日志记录（安全事件审计）
    logger.warn(
      {
        sessionId: context.sessionId,
        userMessage: context.userMessage.slice(0, 200),
        reason: "SAFETY_ROUTE_TRIGGERED",
      },
      "SafetyAgent rejected message",
    );
  }
}
