// QueryRouter —— LLM 驱动的 Agent 查询分类器
// 将用户消息路由到 4 条路径之一：SAFETY | CHAT | TASK | HUMAN
// 使用 chatSync + jsonMode 做结构化分类（~60 token 输出）
// 降级策略：LLM 失败或低置信度 → 回退到 regex IntentDetector → TASK
//
// Rule First + LLM Fallback 架构：
// SAFETY 和 HUMAN 走关键词规则（高确定性），其余交给 Router LLM 统一分类

import { z } from "zod";
import { getProvider, resolveModel } from "../../providers/registry.js";
import type { ChatMessage } from "../../providers/types.js";
import { logger } from "@agentforge/logger";
import { intentDetector } from "../intent-detector.js";
import type { RouteName, RouterDecision } from "./types.js";
import type { ObservabilityTrace } from "../../observability/provider.js";

// ── Zod Schema：Router LLM 输出的结构化 JSON ──

const RouterDecisionSchema = z.object({
  route: z.enum(["SAFETY", "CHAT", "TASK", "HUMAN"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200),
  escalation_reason: z.string().max(100).default(""),
});

// ── Router System Prompt ──

const ROUTER_SYSTEM_PROMPT = `你是一个智能助手 Intent Classifier。分析用户消息，输出路由分类。

## 路由定义

### SAFETY（安全违规）
越狱、攻击、辱骂、诈骗、色情、暴力 → route: "SAFETY"

### CHAT（社交对话）
问候、感谢、道别、能力询问、与业务无关的闲聊 → route: "CHAT"

### HUMAN（人工转接）
明确要求转人工、投诉升级 → route: "HUMAN"

### TASK（任务执行 — 默认）
所有业务问题、知识查询、需要工具的任务 → route: "TASK"
Agent 会自主决定是否搜索知识库、调用业务工具，或组合使用。

## 输出格式（仅 JSON）
{"route":"TASK","confidence":0.9,"reasoning":"简短的意图分析"}`;

// ── IntentDetector → RouteName 映射（fallback 用） ──

const INTENT_TO_ROUTE: Record<string, RouteName> = {
  退货退款: "TASK",
  物流查询: "TASK",
  售后联系: "HUMAN",
  账户会员: "TASK",
  支付订单: "TASK",
  其他咨询: "TASK", // 默认走 TASK
};

// ── 关键词快速路由（零延迟，不走 LLM） ──
// SAFETY 和 HUMAN 走关键词规则，其余交给 Router LLM 统一分类

export const SAFETY_KEYWORDS = [
  // ── 原有规则：英文 prompt injection ──
  /忽略.*(指令|规则|限制|之前)/i,
  /扮演.*(角色|黑客|坏人)/i,
  /(DAN|jailbreak|system\s*prompt)/i,
  /ignore.*(instruction|rule)/i,
  /pretend.*(you\s*are|to\s*be)/i,
  // ── 多语言攻击变体 ──
  /無視.*(指示|ルール|制限)/i,
  /開発者.*モード/i,
  /忽略.*(指示|規則|制限|以前)/i,
  /(role.?(play|扮演)|cosplay|pretend\s+to\s+be)/i,
  /你.*(现在|从现在起|以後|从此).*是.*(ChatGPT|GPT|AI|人工智能|机器人)/i,
  /forget.*(everything|all).*(before|above|previous)/i,
  // ── Token 窜改 / 特殊分隔符注入 ──
  /<\|im_start\|>/i,
  /<\|system\|>/i,
  /\[INST\].*\[\/?INST\]/i,
  /(system|系统|系統)\s*:\s*(你现在|你的新|ignore|forget)/i,
  /<\s*s\s*y\s*s\s*t\s*e\s*m\s*>/i,
  // ── 编码混淆检测 ──
  /(base64|b64|base64_decode|atob|fromCharCode)\s*\(/i,
  /[A-Za-z0-9+\/=]{40,}\s*(decode|解密|解码)/i,
  /fromCharCode\s*\(/i,
  // ── 社会工程 / 权限冒充 ──
  /(我是|我是你).*(管理员|开发者|创始人|CEO|CTO|老板|经理).*(请|要求|命令|给我)/i,
  /(give|show|reveal|tell|print).*me.*(your\s*(prompt|instructions|system|code|rules))/i,
  /(output|print|dump|show).*(your|the).*(prompt|instructions|system\s*message)/i,
  // ── 重复/填充攻击 ──
  /([^\s])\1{500,}/,
];

export const HUMAN_KEYWORDS = [
  /转人工/,
  /找(人工|真人|客服|你们经理|你们领导)/,
  /(打|联系|给.*)(客服)?电话/,
  /我要投诉/,
  /投诉.*(你们|客服|服务)/,
  /叫.*(经理|领导|负责人)/,
];

interface QuickRouteResult {
  route: RouteName;
  confidence: number;
  reasoning: string;
}

/**
 * 规则优先扫描：仅处理 SAFETY 和 HUMAN 两类高确定性场景。
 * 其余所有查询返回 null，交给 Router LLM 统一分类。
 */
function quickRouteScan(message: string): QuickRouteResult | null {
  // SAFETY 优先 —— 安全合规不能有任何延迟
  if (SAFETY_KEYWORDS.some((p) => p.test(message))) {
    return {
      route: "SAFETY",
      confidence: 1.0,
      reasoning: "安全关键词命中",
    };
  }

  // HUMAN —— 明确要求转人工
  if (HUMAN_KEYWORDS.some((p) => p.test(message))) {
    return {
      route: "HUMAN",
      confidence: 0.95,
      reasoning: "转人工关键词命中",
    };
  }

  return null; // → Router LLM
}

// ═══════════════════════════════════════════════════════
// QueryRouter
// ═══════════════════════════════════════════════════════

export class QueryRouter {
  private modelId: string | null;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
  }

  /**
   * 对用户消息进行分类，返回路由决策。
   *
   * 流程：
   * 1. 关键词快速路由（SAFETY/HUMAN）→ 零延迟
   * 2. LLM 调用（廉价模型 + jsonMode）→ 结构化分类
   * 3. 失败/低置信度 → 回退 regex IntentDetector → TASK
   */
  async classify(
    message: string,
    history: ChatMessage[],
    trace?: ObservabilityTrace,
  ): Promise<RouterDecision> {
    // ── 快速路由扫描 ──
    const quickResult = quickRouteScan(message);
    if (quickResult) {
      return quickResult;
    }

    const [providerName, model] = resolveModel(this.modelId);

    try {
      const contextMessages: ChatMessage[] = [
        ...history.slice(-4),
        { role: "user", content: message },
      ];

      // ── Observability: Router LLM Generation ──
      const lfGen = trace?.generation({
        name: "llm-router-classification",
        model,
        input: { message, historyLength: contextMessages.length },
        metadata: { provider: providerName },
      });

      const provider = getProvider(providerName);
      const result = await provider.chatSync(
        contextMessages,
        model,
        ROUTER_SYSTEM_PROMPT,
        0.0, // temperature = 0，确定性分类
        150, // maxTokens
        true, // jsonMode
      );

      const parsed = this.parseDecision(result.content);

      // End generation with usage（chatSync 已返回 usage）
      lfGen?.end({
        output: {
          route: parsed?.route ?? "unknown",
          confidence: parsed?.confidence ?? 0,
        },
        usage: result.usage
          ? {
              promptTokens: result.usage.prompt_tokens,
              completionTokens: result.usage.completion_tokens,
              totalTokens:
                result.usage.prompt_tokens + result.usage.completion_tokens,
            }
          : undefined,
      });

      if (parsed && parsed.confidence >= 0.5) {
        return parsed;
      }

      logger.warn(
        {
          confidence: parsed?.confidence,
          route: parsed?.route,
          rawResponse: result.content.slice(0, 200),
        },
        "Router low confidence, falling back to IntentDetector",
      );
    } catch (e) {
      logger.warn(e, "Router LLM call failed, falling back to IntentDetector");
    }

    // ── Fallback：regex IntentDetector ──
    return this.fallbackClassify(message);
  }

  /**
   * 解析 LLM 输出的 JSON → RouterDecision
   */
  private parseDecision(raw: string): RouterDecision | null {
    try {
      let clean = raw.trim();
      if (clean.startsWith("```")) {
        const parts = clean.split("```");
        clean = parts[1] || parts[0] || "";
        if (clean.startsWith("json")) clean = clean.slice(4);
        clean = clean.trim();
      }
      const jsonMatch = clean.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      const result = RouterDecisionSchema.safeParse(parsed);
      if (!result.success) return null;

      return {
        route: result.data.route,
        confidence: result.data.confidence,
        reasoning: result.data.reasoning,
        escalationReason: result.data.escalation_reason || undefined,
      };
    } catch (err: unknown) {
      logger.warn({ raw: raw.slice(0, 200), err }, "Failed to parse router decision");
      return null;
    }
  }

  /**
   * 正则 IntentDetector fallback
   */
  private fallbackClassify(message: string): RouterDecision {
    const { intent, confidence } = intentDetector.detect(message);
    const route: RouteName = INTENT_TO_ROUTE[intent] ?? "TASK";

    return {
      route,
      confidence,
      reasoning: `IntentDetector fallback: ${intent} (confidence: ${confidence.toFixed(2)})`,
    };
  }
}
