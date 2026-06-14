// QueryRouter —— LLM 驱动的客服查询分类器
// 将用户消息路由到 5 条路径之一：SAFETY | SMALL_TALK | BUSINESS | TOOL | HUMAN
// 使用 chatSync + jsonMode 做结构化分类（~60 token 输出）
// 降级策略：LLM 失败或低置信度 → 回退到 regex IntentDetector → BUSINESS

import { z } from "zod";
import { getProvider, resolveModel } from "../../providers/registry.js";
import type { ChatMessage } from "../../providers/types.js";
import { logger } from "@agentforge/logger";
import { intentDetector } from "../intent-detector.js";
import type { RouteName, RouterDecision } from "./types.js";

// ── Zod Schema：Router LLM 输出的结构化 JSON ──

const RouterDecisionSchema = z.object({
  route: z.enum(["SAFETY", "SMALL_TALK", "TOOL", "HUMAN"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200),
  tools: z.array(z.string().max(30)).max(5).default([]),
  execution_order: z.enum(["parallel", "sequential"]).default("parallel"),
  escalation_reason: z.string().max(100).default(""),
});

// ── Router System Prompt ──

const ROUTER_SYSTEM_PROMPT = `你是一个客服 Intent Classifier。分析用户消息，输出路由 + 推荐的工具列表 + 执行顺序。

## 可用工具

| 工具名 | 用途 | 触发场景 |
|--------|------|----------|
| lookup_order | 查询订单详情 | 用户提供订单号、问订单状态 |
| check_shipping_status | 查询物流进度 | 问快递到哪了、物流状态 |
| check_return_policy | 查询退换货政策 | 问怎么退货、退款、换货条件 |
| search_knowledge_base | 搜索知识库 | 问会员权益、支付方式、促销活动等政策 |
| create_support_ticket | 创建客服工单 | 投诉、问题无法在线解决、要求工单记录 |
| get_current_time | 获取当前时间 | 间接需要（Agent 自动判断） |

## 路由定义

### SAFETY（安全违规）
越狱、攻击、辱骂、诈骗、色情、暴力 → route: "SAFETY", tools: []

### SMALL_TALK（社交对话）
问候、感谢、道别、能力询问、与业务无关的闲聊 → route: "SMALL_TALK", tools: []

### HUMAN（人工转接）
明确要求转人工、投诉升级 → route: "HUMAN", tools: ["create_support_ticket"]

### TOOL（工具调用 — 默认）
所有业务问题 → route: "TOOL"

## 工具推荐规则
- 简单问题推荐 1 个工具
- 组合问题推荐多个工具（如"订单到哪了+如果丢件怎么赔"→["lookup_order","check_shipping_status","search_knowledge_base"]）
- 不确定是否需要某个工具时宁可多推荐
- tools: [] 表示 Agent 直接回复，不调工具

## execution_order
- "parallel": 工具之间无依赖，可同时调用（如查订单+查政策）
- "sequential": 后一个工具依赖前一个的结果（如先查订单→根据结果查物流）

## 输出格式（仅 JSON）
{"route":"TOOL","confidence":0.9,"reasoning":"简短的意图分析","tools":["lookup_order","check_shipping_status"],"execution_order":"parallel"}`;

// ── IntentDetector → RouteName 映射（fallback 用） ──

const INTENT_TO_ROUTE: Record<string, RouteName> = {
  退货退款: "TOOL",
  物流查询: "TOOL",
  售后联系: "HUMAN",
  账户会员: "TOOL",
  支付订单: "TOOL",
  其他咨询: "TOOL", // 默认走 TOOL（统一 Agent 有全部工具）
};

// ── 关键词快速路由（零延迟，不走 LLM） ──
// 处理高置信度模式：SAFETY 扫描 + HUMAN/TOOL/BUSINESS 快速路由
// 这些规则弥补 LLM Router 的分类不稳定问题

const SAFETY_KEYWORDS = [
  /忽略.*(指令|规则|限制|之前)/i,
  /扮演.*(角色|黑客|坏人)/i,
  /(DAN|jailbreak|system\s*prompt)/i,
  /ignore.*(instruction|rule)/i,
  /pretend.*(you\s*are|to\s*be)/i,
];

const HUMAN_KEYWORDS = [
  /转人工/,
  /找(人工|真人|客服|你们经理|你们领导)/,
  /(打|联系|给.*)(客服)?电话/,
  /我要投诉/,
  /投诉.*(你们|客服|服务)/,
  /叫.*(经理|领导|负责人)/,
];

// Rule First + LLM Fallback 架构：
// 仅 SAFETY 和 HUMAN 走关键词规则（高确定性），其余全部交给 Router LLM → Tool Calling

interface QuickRouteResult {
  route: RouteName;
  confidence: number;
  reasoning: string;
}

/**
 * 规则优先扫描：仅处理 SAFETY（安全合规）和 HUMAN（转人工）两类高确定性场景。
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

  // HUMAN —— 明确要求转人工，确定性极高
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
   * 1. 关键词快速路由（SAFETY/HUMAN/TOOL/BUSINESS 高置信度模式）→ 零延迟
   * 2. LLM 调用（廉价模型 + jsonMode）→ 结构化分类
   * 3. 失败/低置信度 → 回退 regex IntentDetector → BUSINESS
   */
  async classify(
    message: string,
    history: ChatMessage[],
  ): Promise<RouterDecision> {
    // ── 快速路由扫描（高置信度模式） ──
    const quickResult = quickRouteScan(message);
    if (quickResult) {
      return quickResult;
    }

    const [providerName, model] = resolveModel(this.modelId);

    try {
      // 构建精简上下文（用户消息 + 最近 4 条历史）
      const contextMessages: ChatMessage[] = [
        ...history.slice(-4),
        { role: "user", content: message },
      ];

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
      if (parsed && parsed.confidence >= 0.5) {
        return parsed;
      }

      // 低置信度 → fallback
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
      // 提取 JSON（可能包裹在 markdown 中）
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
        tools: result.data.tools.length > 0 ? result.data.tools : undefined,
        execution_order: result.data.execution_order,
        escalationReason: result.data.escalation_reason || undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * 正则 IntentDetector fallback
   */
  private fallbackClassify(message: string): RouterDecision {
    const { intent, confidence } = intentDetector.detect(message);
    const route = INTENT_TO_ROUTE[intent] || "BUSINESS";

    return {
      route,
      confidence,
      reasoning: `IntentDetector fallback: ${intent} (confidence: ${confidence.toFixed(2)})`,
    };
  }
}
