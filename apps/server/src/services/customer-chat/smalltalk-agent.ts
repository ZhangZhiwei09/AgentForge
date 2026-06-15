// SmallTalkAgent —— 处理社交对话（问候、自我介绍、感谢、道别、能力询问）
// 替代 CONVERSATIONAL_RULES 数组的 LLM 方案
// 用聚焦的对话 prompt + jsonMode，不查知识库，不调工具
// 天然多语言：LLM 理解 "Who are you?"、"你是谁"、"あなたは誰？"

import { z } from "zod";
import { getProvider } from "../../providers/registry.js";
import type { ChatMessage } from "../../providers/types.js";
import { logger } from "@agentforge/logger";
import { extractJSONFromLLMResponse } from "../../lib/json-utils.js";
import type { RouteAgent, RouteContext, RouteStreamEvent } from "./types.js";
import type { ExecutionScope } from "../../runtime/scope.js";
import { streamTokens } from "./types.js";

// ── Zod Schema ──

const SmallTalkResponseSchema = z.object({
  answer: z.string().min(1).max(2000),
  suggestions: z.array(z.string().max(50)).max(3).default([]),
});

// ── SmallTalk System Prompt ──

const SMALLTALK_SYSTEM_PROMPT = `你是 AgentForge 平台的智能客服助手，当前正在进行基本社交对话。

你的身份：
- 你是 AgentForge 智能客服助手，由 AI 驱动
- 你可以帮助客户解答：订单与物流、退换货政策、支付与优惠券、账户与会员等问题

## 规则
1. 自然友好地回复，不需要引用知识库
2. 绝对禁止编造任何业务政策、价格、流程等事实信息
3. 如果用户问你能做什么，请简洁列出你的能力范围（使用无序列表格式）
4. 如果用户的问题超出社交范围（涉及具体业务），引导他们提出具体问题
5. 回复简洁礼貌，1-3 句话为佳
6. 多语言支持：用户用什么语言问候，你就用什么语言回复
7. 可以适当使用 Markdown 格式（**粗体**、列表）让回复更有层次

## 输出格式
严格按照以下 JSON 格式输出，不要任何前言后记：
{"answer": "你的回答文本（可含 Markdown 格式）", "suggestions": ["建议追问1", "建议追问2"]}

- answer: 给客户的回答，1-2000 字符
- suggestions: 2-3 个建议后续问题，每个不超过 50 字符。无法生成时写空数组 []`;

// ═══════════════════════════════════════════════════════
// SmallTalkAgent
// ═══════════════════════════════════════════════════════

export class SmallTalkAgent implements RouteAgent {
  readonly route = "SMALL_TALK" as const;

  async *execute(
    context: RouteContext,
    _scope?: ExecutionScope,
  ): AsyncGenerator<RouteStreamEvent> {
    const {
      resolvedModel,
      providerName,
      userMessage,
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
      route: "SMALL_TALK",
    };

    // LLM 调用
    let answer: string;
    let suggestions: string[] = [];
    let fallbackUsed = false;

    try {
      const provider = getProvider(providerName);
      const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

      const result = await provider.chatSync(
        messages,
        resolvedModel,
        SMALLTALK_SYSTEM_PROMPT,
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
        answer = result.content.trim() || "您好！有什么可以帮助您的吗？";
        fallbackUsed = answer === "您好！有什么可以帮助您的吗？"; // 空内容兜底
      }
    } catch (e) {
      logger.warn(e, "SmallTalkAgent LLM call failed, using fallback");
      answer = "您好！我是 AgentForge 智能客服助手，有什么可以帮助您的吗？";
      fallbackUsed = true;
    }

    // 逐字符流式输出
    yield* streamTokens(answer, assistantMsgId);

    // 发送 done
    yield {
      type: "done" as const,
      message_id: assistantMsgId,
      usage: {},
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      memory: { injected: 0, extracted: 0 },
      validated: true,
      fallback_used: fallbackUsed || undefined,
      route: "SMALL_TALK" as const,
    };
  }

  private parseResponse(
    raw: string,
  ): { answer: string; suggestions: string[] } | null {
    try {
      const jsonStr = extractJSONFromLLMResponse(raw);
      const parsed = JSON.parse(jsonStr);
      const result = SmallTalkResponseSchema.safeParse(parsed);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }
}
