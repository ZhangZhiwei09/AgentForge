// ChatAgent —— 处理社交对话（问候、自我介绍、能力询问）
// 角色定义从 @agentforge/shared-prompts 的 AGENTFORGE_PERSONA 加载
// 不查知识库，不调工具，只做对话路由
// 天然多语言：LLM 理解 "Who are you?"、"你是谁"、"あなたは誰？"

import { z } from "zod";
import { getProvider } from "../../providers/registry.js";
import type { ChatMessage } from "../../providers/types.js";
import { logger } from "@agentforge/logger";
import { extractJSONFromLLMResponse } from "../../lib/json-utils.js";
import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import type { ExecutionScope } from "../../runtime/scope.js";
import { streamTokens } from "./types.js";
import {
  AGENTFORGE_PERSONA,
  buildChatSystemPrompt,
  type Persona,
} from "@agentforge/shared-prompts";
import { agentRouteInvocations } from "../../observability/metrics.js";

// ── Zod Schema ──

const ChatResponseSchema = z.object({
  answer: z.string().min(1).max(2000),
  suggestions: z.array(z.string().max(50)).max(3).default([]),
});

// ═══════════════════════════════════════════════════════
// ChatAgent
// ═══════════════════════════════════════════════════════

export class ChatAgent implements RouteAgent {
  readonly route = "CHAT" as const;
  private systemPrompt: string;

  constructor(persona?: Persona) {
    const p = persona ?? AGENTFORGE_PERSONA;
    this.systemPrompt = buildChatSystemPrompt(p);
  }

  async *execute(
    context: RouteContext,
    _scope?: ExecutionScope,
  ): AsyncGenerator<RouteStreamEvent> {
    const {
      resolvedModel,
      providerName,
      userMessage,
      history,
      sessionId,
      assistantMsgId,
    } = context;

    // 发送 meta
    yield {
      type: "meta",
      message_id: assistantMsgId,
      session_id: sessionId,
      model: resolvedModel,
      provider: providerName,
      knowledge: [],
      intent: context.intent,
      within_service_hours: context.withinServiceHours,
      memory_count: 0,
      route: "CHAT",
    };

    // LLM 调用
    let answer: string;
    let suggestions: string[] = [];
    let fallbackUsed = false;

    try {
      const provider = getProvider(providerName);

      // 构建消息列表：传入最近对话历史 + 当前用户消息
      const messages: ChatMessage[] = [
        ...(history ?? []).slice(-6), // 最近 3 轮对话
        { role: "user" as const, content: userMessage },
      ];

      const result = await provider.chatSync(
        messages,
        resolvedModel,
        this.systemPrompt,
        0.3,
        512,
        true, // jsonMode
      );

      const parsed = this.parseResponse(result.content);
      if (parsed) {
        answer = parsed.answer;
        suggestions = parsed.suggestions;
      } else {
        // JSON 解析失败 → 使用原始文本
        answer = result.content.trim() || "你好，有什么可以帮助你的？";
        fallbackUsed = answer === "你好，有什么可以帮助你的？"; // 空内容兜底
      }
    } catch (e) {
      logger.warn(e, "ChatAgent LLM call failed, using fallback");
      agentRouteInvocations.inc({ route: "CHAT", status: "error" });
      answer = "我是 AgentForge 智能助手，我能查询知识库、诊断系统故障。请告诉我你需要什么帮助？";
      fallbackUsed = true;
    }

    // 逐字符流式输出
    yield* streamTokens(answer, assistantMsgId);

    // 发送 done
    agentRouteInvocations.inc({ route: "CHAT", status: "success" });
    yield {
      type: "done" as const,
      message_id: assistantMsgId,
      usage: {},
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      memory: { injected: 0, extracted: 0 },
      validated: true,
      fallback_used: fallbackUsed || undefined,
      route: "CHAT" as const,
    };
  }

  private parseResponse(
    raw: string,
  ): { answer: string; suggestions: string[] } | null {
    try {
      const jsonStr = extractJSONFromLLMResponse(raw);
      const parsed = JSON.parse(jsonStr);
      const result = ChatResponseSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch (err: unknown) {
      logger.warn({ raw: raw.slice(0, 200), err }, "Failed to parse chat response JSON");
      return null;
    }
  }
}
