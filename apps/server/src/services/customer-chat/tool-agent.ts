// ToolAgent —— 客服工具调用
// 包装 AgentService.run() 的 ReAct 循环
// 将 agent SSE 事件映射到 customer-chat SSE 协议
// 启用客服工具集，限制 maxIterations: 5

import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
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
      let accumulatedContent = "";

      for await (const event of events) {
        switch (event.type) {
          case "agent_token":
            // 累积 token，但不逐 token 转发（ReAct 会有多次 token 流）
            if ("content" in event) {
              accumulatedContent += event.content;
            }
            break;

          case "agent_respond":
            // Agent 最终响应
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
            // Agent 会话正常结束，finalAnswer 可能已经在 agent_respond 中设置
            break;

          default:
            // agent_think, agent_plan, agent_act, agent_observe 等不转发到客户
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

    // 逐字符流式输出最终答案
    for (const char of finalAnswer) {
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
