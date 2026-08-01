// L3/L4 LLM 路由 —— Few-Shot 增强 + 原始 LLM Router
//
// L3: 将 L2 检索到的相似样本注入 system prompt 作为参考示例，调用 LLM 分类。
// L4: 纯 LLM Router（无 few-shot 示例），当 L2/L3 无法确定时兜底。
//
// 从 router.ts 提取，保持原有逻辑不变。

import { z } from "zod";
import { getProvider, resolveModel } from "../../../providers/registry.js";
import type { ChatMessage } from "../../../providers/types.js";
import { logger } from "@agentforge/logger";
import { ErrorCode } from "../errors/codes.js";
import type { RouterDecision } from "../types.js";
import type { ObservabilityTrace } from "../../../observability/provider.js";
import type { SemanticMatch } from "./l2-semantic.js";

// ── Zod Schema：Router LLM 输出的结构化 JSON ──

export const RouterDecisionSchema = z.object({
  route: z.enum(["SAFETY", "CHAT", "TASK", "HUMAN", "DIAGNOSIS"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200),
  escalation_reason: z.string().max(100).default(""),
});

// ── Router System Prompt ──

export const ROUTER_SYSTEM_PROMPT = `你是一个智能助手 Intent Classifier。分析用户消息，输出路由分类。

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

// ── Route 中文标签 ──

export const ROUTE_LABELS: Record<string, string> = {
  SAFETY: "安全违规",
  CHAT: "社交对话",
  TASK: "任务执行",
  HUMAN: "人工转接",
  DIAGNOSIS: "故障诊断",
};

// ── Few-Shot Prompt Builder ──

/**
 * 用 L2 检索到的相似样本构建 few-shot 增强 prompt。
 * 选取 Top-3 相似度 > 0.4 的样本注入 system prompt 末尾。
 */
export function buildFewShotPrompt(topMatches: SemanticMatch[]): string {
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
    `\n\n注意：DIAGNOSIS 路由要求用户提供了具体的故障信息（明确的错误现象、traceId、errorCode 等）。` +
    `仅有模糊的"有问题"、"不行"等描述而没有任何具体细节时，应路由到 TASK 或 CHAT，让 Agent 进一步询问。`
  );
}

// ── JSON 解析 ──

/**
 * 解析 LLM 输出的 JSON → RouterDecision
 */
export function parseRouterDecision(raw: string): RouterDecision | null {
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
    logger.warn({ errorCode: ErrorCode.RT_PARSE_FAILED, raw: raw.slice(0, 200), err }, "Failed to parse router decision");
    return null;
  }
}

// ── L3 Few-Shot LLM Router ──

/**
 * L3: Few-Shot 增强 LLM Router。
 * 将 L2 检索到的相似样本注入 system prompt 作为参考示例。
 */
export async function fewShotClassify(
  message: string,
  history: ChatMessage[],
  topMatches: SemanticMatch[],
  modelId: string | null,
  trace?: ObservabilityTrace,
): Promise<RouterDecision | null> {
  const { providerName, modelId: model } = resolveModel(modelId);

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

    const parsed = parseRouterDecision(result.content);

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
      { errorCode: ErrorCode.RT_L3_LOW_CONFIDENCE, confidence: parsed?.confidence, route: parsed?.route },
      "Router L3: low confidence or parse failure, falling through to L4",
    );
    return null;
  } catch (e) {
    logger.warn({ errorCode: ErrorCode.RT_L3_LLM_FAILED, err: e }, "Router L3: LLM call failed, falling through to L4");
    return null;
  }
}

// ── L4 原始 LLM Router ──

/**
 * L4: 原始 LLM Router（无 few-shot 示例增强）。
 * 当 L2 和 L3 都无法确定时兜底。
 */
export async function llmClassify(
  message: string,
  history: ChatMessage[],
  modelId: string | null,
  trace?: ObservabilityTrace,
): Promise<RouterDecision | null> {
  const { providerName, modelId: model } = resolveModel(modelId);

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

    const parsed = parseRouterDecision(result.content);

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
      { errorCode: ErrorCode.RT_L4_LOW_CONFIDENCE, confidence: parsed?.confidence, route: parsed?.route },
      "Router L4: low confidence, falling back to IntentDetector",
    );
  } catch (e) {
    logger.warn({ errorCode: ErrorCode.RT_L4_LLM_FAILED, err: e }, "Router L4: LLM call failed, falling back to IntentDetector");
  }

  return null;
}
