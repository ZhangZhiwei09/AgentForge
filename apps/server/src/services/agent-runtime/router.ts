// QueryRouter —— LLM 驱动的 Agent 查询分类器
// 将用户消息路由到 5 条路径之一：SAFETY | CHAT | TASK | HUMAN | DIAGNOSIS
// 使用 chatSync + jsonMode 做结构化分类（~60 token 输出）
// 降级策略：LLM 失败或低置信度 → 回退到 regex IntentDetector → TASK
//
// V12 多层路由架构：
//   L1: 关键词快速路由（SAFETY、HUMAN、DIAGNOSIS 走关键词规则，零延迟）
//   L2: 语义意图分类（Embedding + pgvector k-NN，<50ms）
//   L3: Few-Shot 增强 LLM Router（L2 中置信度时，注入相似样本作参考）
//   L4: 原始 LLM Router（兜底）
//   L5: IntentDetector fallback（regex 最终兜底）

import { z } from "zod";
import { getProvider, resolveModel } from "../../providers/registry.js";
import type { ChatMessage } from "../../providers/types.js";
import { logger } from "@agentforge/logger";
import { intentDetector } from "../intent-detector.js";
import type { RouteName, RouterDecision } from "./types.js";
import type { ObservabilityTrace } from "../../observability/provider.js";
import {
  SemanticClassifier,
  getSemanticClassifier,
  type SemanticMatch,
} from "./semantic-classifier.js";

// ── Zod Schema：Router LLM 输出的结构化 JSON ──

const RouterDecisionSchema = z.object({
  route: z.enum(["SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"]),
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

### DIAGNOSIS（故障诊断）
用户描述了具体的故障现象（报错、失败、超时、崩溃、打不开），
或明确要求排查/诊断帮助，或提供了 traceId/errorCode → route: "DIAGNOSIS"
触发多 Agent 协同诊断流程（前端排查 → 后端排查 → 综合分析）。

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

export const DIAGNOSIS_KEYWORDS = [
  // 强信号：错误码 + traceId
  /traceId\s*[:：]\s*\w+/i,
  /error[_ ]?code\s*[:：]\s*\w+/i,
  // 故障关键词
  /(报错|失败|超时|打不开|连不上|崩溃|闪退|白屏|卡死)/,
  /(排查|诊断|定位|帮我看下|帮我查下|帮我查|帮我看看|帮我看|帮我分析).*(问题|原因|怎么回事|什么情况|什么原因)/,
  /(摄像头|麦克风|活体|刷脸|人脸|认证|识别).*(失败|打不开|不能用|没反应|超时|异常)/,
  /(WebSocket|网络|连接).*(断开|超时|失败)/,
  /(成功率|通过率).*(下跌|下降|降低|异常|掉|低)/,
];

interface QuickRouteResult {
  route: RouteName;
  confidence: number;
  reasoning: string;
}

/**
 * L1 规则优先扫描：处理 SAFETY、HUMAN、DIAGNOSIS 三类高确定性场景。
 * 其余所有查询返回 null，交给 L2 SemanticClassifier。
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

  // DIAGNOSIS —— 故障排查/诊断类问题
  if (DIAGNOSIS_KEYWORDS.some((p) => p.test(message))) {
    return {
      route: "DIAGNOSIS",
      confidence: 0.85,
      reasoning: "诊断关键词命中",
    };
  }

  return null; // → Router LLM
}

// ── L3 Few-Shot Prompt Builder ──

const ROUTE_LABELS: Record<string, string> = {
  SAFETY: "安全违规",
  CHAT: "社交对话",
  TASK: "任务执行",
  HUMAN: "人工转接",
  DIAGNOSIS: "故障诊断",
};

/**
 * 用 L2 检索到的相似样本构建 few-shot 增强 prompt。
 * 选取 Top-3 相似度 > 0.4 的样本注入 system prompt 末尾。
 */
function buildFewShotPrompt(topMatches: SemanticMatch[]): string {
  const examples = topMatches
    .filter((m) => m.similarity > 0.4)
    .slice(0, 3)
    .map(
      (m) =>
        `用户："${m.text}"\n→ 分类: ${ROUTE_LABELS[m.route] ?? m.route} (route: "${m.route}")`,
    )
    .join("\n\n");

  if (!examples) return ROUTER_SYSTEM_PROMPT;

  return (
    ROUTER_SYSTEM_PROMPT +
    `\n\n## 参考示例（从历史样本中检索到的相似消息及其正确分类）\n\n${examples}` +
    `\n\n注意：当用户描述任何异常现象（卡住、闪退、报错、超时、弹回、进不去、没反应等），` +
    `即使没有明确的错误码，也应优先考虑 DIAGNOSIS 路由。客户服务场景中的模糊故障描述通常意味着需要排查。`
  );
}

// ═══════════════════════════════════════════════════════
// QueryRouter
// ═══════════════════════════════════════════════════════

export class QueryRouter {
  private modelId: string | null;
  private semanticRouter: SemanticClassifier;

  constructor(modelId?: string | null) {
    this.modelId = modelId || null;
    this.semanticRouter = getSemanticClassifier();
  }

  /**
   * 对用户消息进行分类，返回路由决策。
   *
   * V12 多层流程：
   *   1. L1 关键词快速路由（SAFETY/HUMAN/DIAGNOSIS）→ 零延迟
   *   2. L2 语义意图分类（Embedding + pgvector k-NN）→ <50ms
   *   3. L3 Few-Shot 增强 LLM Router（L2 中置信度时）→ ~500ms
   *   4. L4 原始 LLM Router（兜底）→ ~500ms
   *   5. Fallback: regex IntentDetector → TASK
   */
  async classify(
    message: string,
    history: ChatMessage[],
    trace?: ObservabilityTrace,
  ): Promise<RouterDecision> {
    // ── L1: 关键词快速路由 ──
    const quickResult = quickRouteScan(message);
    if (quickResult) {
      return quickResult;
    }

    // ── L2: 语义意图分类（Embedding + pgvector k-NN）──
    const l2Start = Date.now();
    const semanticResult = await this.semanticRouter.classify(message);
    const l2Ms = Date.now() - l2Start;

    if (semanticResult) {
      // L2 高置信度（≥ 0.8）→ 直接返回
      if (semanticResult.confidence >= 0.8) {
        logger.info(
          { route: semanticResult.route, confidence: semanticResult.confidence, l2Ms },
          "Router: L2 semantic classification (high confidence), returning directly",
        );
        return {
          route: semanticResult.route,
          confidence: semanticResult.confidence,
          reasoning: semanticResult.reasoning,
        };
      }

      // L2 中置信度（0.5 ~ 0.8）→ L3 Few-Shot 增强
      if (semanticResult.confidence >= 0.5 && semanticResult.matches.length > 0) {
        logger.info(
          {
            route: semanticResult.route,
            confidence: semanticResult.confidence,
            matchCount: semanticResult.matches.length,
            l2Ms,
          },
          "Router: L2 medium confidence, escalating to L3 Few-Shot LLM",
        );

        const l3Result = await this.fewShotClassify(
          message,
          history,
          semanticResult.matches,
          trace,
        );
        if (l3Result) return l3Result;
      }
    } else {
      logger.info({ l2Ms }, "Router: L2 skipped (no embedding provider or no matches)");
    }

    // ── L4: 原始 LLM Router ──
    return this.llmClassify(message, history, trace);
  }

  /**
   * L3: Few-Shot 增强 LLM Router。
   * 将 L2 检索到的相似样本注入 system prompt 作为参考示例。
   */
  private async fewShotClassify(
    message: string,
    history: ChatMessage[],
    topMatches: SemanticMatch[],
    trace?: ObservabilityTrace,
  ): Promise<RouterDecision | null> {
    const [providerName, model] = resolveModel(this.modelId);

    try {
      const contextMessages: ChatMessage[] = [
        ...history.slice(-4),
        { role: "user", content: message },
      ];

      const enhancedPrompt = buildFewShotPrompt(topMatches);

      const lfGen = trace?.generation({
        name: "llm-router-few-shot",
        model,
        input: { message, fewShotCount: topMatches.length },
        metadata: { provider: providerName },
      });

      const provider = getProvider(providerName);
      const result = await provider.chatSync(
        contextMessages,
        model,
        enhancedPrompt,
        0.0,
        200,
        true,
      );

      const parsed = this.parseDecision(result.content);

      lfGen?.end({
        output: {
          route: parsed?.route ?? "unknown",
          confidence: parsed?.confidence ?? 0,
        },
        usage: result.usage
          ? {
              promptTokens: result.usage.prompt_tokens,
              completionTokens: result.usage.completion_tokens,
              totalTokens: result.usage.prompt_tokens + result.usage.completion_tokens,
            }
          : undefined,
      });

      if (parsed && parsed.confidence >= 0.5) {
        // DIAGNOSIS 高门槛
        if (parsed.route === "DIAGNOSIS" && parsed.confidence < 0.7) {
          logger.info(
            { confidence: parsed.confidence },
            "Router L3: DIAGNOSIS but confidence < 0.7, falling through to L4",
          );
          return null;
        }
        parsed.reasoning = `L3少样本增强: ${parsed.reasoning}`;
        return parsed;
      }

      logger.warn(
        { confidence: parsed?.confidence, route: parsed?.route },
        "Router L3: low confidence or parse failure, falling through to L4",
      );
      return null;
    } catch (e) {
      logger.warn(e, "Router L3: LLM call failed, falling through to L4");
      return null;
    }
  }

  /**
   * L4: 原始 LLM Router（无 few-shot 示例增强）。
   * 当 L2 和 L3 都无法确定时兜底。
   */
  private async llmClassify(
    message: string,
    history: ChatMessage[],
    trace?: ObservabilityTrace,
  ): Promise<RouterDecision> {
    const [providerName, model] = resolveModel(this.modelId);

    try {
      const contextMessages: ChatMessage[] = [
        ...history.slice(-4),
        { role: "user", content: message },
      ];

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
        0.0,
        150,
        true,
      );

      const parsed = this.parseDecision(result.content);

      lfGen?.end({
        output: {
          route: parsed?.route ?? "unknown",
          confidence: parsed?.confidence ?? 0,
        },
        usage: result.usage
          ? {
              promptTokens: result.usage.prompt_tokens,
              completionTokens: result.usage.completion_tokens,
              totalTokens: result.usage.prompt_tokens + result.usage.completion_tokens,
            }
          : undefined,
      });

      if (parsed) {
        if (parsed.route === "DIAGNOSIS" && parsed.confidence < 0.7) {
          logger.info(
            { confidence: parsed.confidence },
            "Router L4: DIAGNOSIS but confidence < 0.7, falling back to IntentDetector",
          );
        } else if (parsed.confidence >= 0.5) {
          return parsed;
        }
      }

      logger.warn(
        { confidence: parsed?.confidence, route: parsed?.route },
        "Router L4: low confidence, falling back to IntentDetector",
      );
    } catch (e) {
      logger.warn(e, "Router L4: LLM call failed, falling back to IntentDetector");
    }

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
