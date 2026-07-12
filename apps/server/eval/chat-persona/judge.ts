// LLM-as-Judge —— ChatAgent 回复质量评估
//
// 对 Golden Case 中的 judgeRubric 维度进行 1-5 打分。
// 一个 case 可能有多个 judgeRubric（如 identity-who-are-you 有 role_consistency + accuracy），
// 合并为一次 LLM 调用以节省成本。
//
// 用法：
//   import { evaluateResponse } from "./judge.js";
//   const result = await evaluateResponse(client, model, goldenCase, actualAnswer);

import OpenAI from "openai";
import { z } from "zod";
import type { GoldenTestCase, GoldenExpectedBehavior } from "./golden-cases.js";

// ── Judge 输出 Schema ──

const DimensionScoreSchema = z.object({
  score: z.number().int().min(1).max(5),
  reason: z.string().max(200),
});

const JudgeOutputSchema = z.object({
  dimensions: z.record(z.string(), DimensionScoreSchema),
  issues: z.array(z.string().max(200)).max(10),
  overall_verdict: z.enum(["PASS", "FAIL"]),
  overall_comment: z.string().max(300),
});

export interface JudgeResult {
  /** 按 dimension 名称索引的评分 */
  dimensions: Record<string, { score: number; reason: string }>;
  /** 发现的问题列表 */
  issues: string[];
  /** 综合判断 */
  overallVerdict: "PASS" | "FAIL";
  /** 综合评价 */
  overallComment: string;
  /** 原始 LLM 响应（调试用） */
  rawResponse?: string;
}

export interface EvaluateOptions {
  /** LLM 调用温度，默认 0.1（Judge 需要确定性） */
  temperature?: number;
  /** 最大重试次数（JSON 解析失败时），默认 2 */
  maxRetries?: number;
  /** 超时毫秒，默认 30_000 */
  timeoutMs?: number;
}

// ── Judge System Prompt 构建 ──

function buildJudgePrompt(
  goldenCase: GoldenTestCase,
  answer: string,
): string {
  // 只取有 judgeRubric 的 behavior
  const rubricBehaviors: GoldenExpectedBehavior[] = goldenCase.expectedBehaviors.filter(
    (b) => b.judgeRubric !== undefined,
  );

  const personaSummary = `你是 AgentForge 平台的智能助手，面向企业内部用户提供技术支持。
角色：技术支持专家
能力：1) 查询知识库中的文档和操作指南；2) 诊断和排查系统故障
红线：不编造功能/政策、不执行实际操作、不回答职责外问题、不使用通用AI自我介绍`;

  const dimensionsText = rubricBehaviors
    .map((b, i) => {
      const rubric = b.judgeRubric!;
      return `### 维度 ${i + 1}：${rubric.dimension}
评分指南：${rubric.scoringGuide}
最低合格分：${rubric.minScore ?? 3}`;
    })
    .join("\n\n");

  const dimensionNames = rubricBehaviors.map((b) => b.judgeRubric!.dimension);

  return `你是一个公正的评估者，需要评估一个 AI 助手回复的质量。

## 助手角色设定

${personaSummary}

## 评估场景

用户消息："${goldenCase.input}"
场景说明：${goldenCase.description}

助手回复：
"""
${answer}
"""

## 评分维度

${dimensionsText}

## 输出格式

请严格按照以下 JSON 格式输出评估结果，不要任何前言后记：

{
  "dimensions": {
    "${dimensionNames[0] || "dimension"}": {
      "score": 4,
      "reason": "评分理由（一句话，不超过200字）"
    }
  },
  "issues": ["发现的问题1", "问题2"],
  "overall_verdict": "PASS",
  "overall_comment": "综合评价（不超过300字）"
}

规则：
- score 必须是 1-5 的整数。5=完美，3=可接受但不够好，1=完全不可接受
- 如果任一维度的分数低于该维度的最低合格分（默认3），overall_verdict 必须为 "FAIL"
- issues 列出所有发现的问题，如果没问题写空数组 []
- 评价要具体：指出回复中哪里做得好、哪里需要改进，不要泛泛而谈`;
}

// ── 解析 Judge LLM 输出 ──

function parseJudgeOutput(raw: string): z.infer<typeof JudgeOutputSchema> | null {
  try {
    let clean = raw.trim();
    // 处理 markdown code block
    if (clean.startsWith("```")) {
      const parts = clean.split("```");
      clean = parts[1] || parts[0] || "";
      if (clean.startsWith("json")) clean = clean.slice(4);
      clean = clean.trim();
    }
    const parsed = JSON.parse(clean);
    const result = JudgeOutputSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// ── 主评估函数 ──

/**
 * 评估 ChatAgent 的一条回复。
 *
 * @param client - OpenAI 客户端实例
 * @param model - 用于 Judge 的模型 ID（推荐 gpt-4o-mini 或 deepseek-chat）
 * @param goldenCase - Golden Test Case 定义
 * @param answer - ChatAgent 的实际回复文本
 * @param options - 可选配置
 * @returns JudgeResult — 结构化评估结果
 */
export async function evaluateResponse(
  client: OpenAI,
  model: string,
  goldenCase: GoldenTestCase,
  answer: string,
  options: EvaluateOptions = {},
): Promise<JudgeResult> {
  const {
    temperature = 0.1,
    maxRetries = 2,
    timeoutMs = 30_000,
  } = options;

  const rubricBehaviors = goldenCase.expectedBehaviors.filter(
    (b) => b.judgeRubric !== undefined,
  );

  // 没有 judgeRubric 的 case 跳过 Judge 评估
  if (rubricBehaviors.length === 0) {
    return {
      dimensions: {},
      issues: [],
      overallVerdict: "PASS",
      overallComment: "无需 LLM 评判（该 case 没有定义 judgeRubric）",
    };
  }

  const systemPrompt = buildJudgePrompt(goldenCase, answer);

  let lastRaw = "";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const response = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `请评估以上助手回复。直接输出 JSON，不要任何解释。`,
            },
          ],
          temperature,
          max_tokens: 1024,
        },
        { signal: controller.signal },
      );

      clearTimeout(timeoutId);

      lastRaw = response.choices[0]?.message?.content?.trim() || "";

      const parsed = parseJudgeOutput(lastRaw);
      if (parsed) {
        // Zod inferred 类型转为 JudgeResult（Zod 的 Record value 有可选字段，需显式断言）
        const dimensions: Record<string, { score: number; reason: string }> = {};
        for (const [key, val] of Object.entries(parsed.dimensions)) {
          if (typeof val.score === "number" && typeof val.reason === "string") {
            dimensions[key] = { score: val.score, reason: val.reason };
          }
        }
        return {
          dimensions,
          issues: parsed.issues,
          overallVerdict: parsed.overall_verdict,
          overallComment: parsed.overall_comment,
          rawResponse: lastRaw,
        };
      }

      // JSON 解析失败 → 重试
      if (attempt < maxRetries) {
        console.log(
          `       ⚠ Judge JSON 解析失败 (尝试 ${attempt + 1}/${maxRetries})，重试...`,
        );
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        console.log(`       ⚠ Judge 调用超时 (${timeoutMs}ms)`);
      } else {
        const msg = e instanceof Error ? e.message : "Unknown error";
        console.log(`       ⚠ Judge 调用失败: ${msg.slice(0, 80)}`);
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  // 所有重试都失败 → 返回 fallback 结果
  return {
    dimensions: {},
    issues: ["Judge LLM 调用失败，无法完成评估"],
    overallVerdict: "FAIL",
    overallComment: `Judge 评估失败：LLM 返回无法解析。原始响应前200字符: ${lastRaw.slice(0, 200)}`,
    rawResponse: lastRaw,
  };
}

/**
 * 批量评估多条回复。
 * 串行执行以避免 LLM API 限流。
 */
export async function evaluateBatch(
  client: OpenAI,
  model: string,
  items: Array<{ goldenCase: GoldenTestCase; answer: string; label?: string }>,
  options?: EvaluateOptions,
): Promise<
  Array<{
    goldenCase: GoldenTestCase;
    answer: string;
    label?: string;
    judgeResult: JudgeResult;
  }>
> {
  const results: Array<{
    goldenCase: GoldenTestCase;
    answer: string;
    label?: string;
    judgeResult: JudgeResult;
  }> = [];

  for (const item of items) {
    const labelStr = item.label ? `[${item.label}] ` : "";
    console.log(`  ${labelStr}评判: ${item.goldenCase.name}`);

    const judgeResult = await evaluateResponse(
      client,
      model,
      item.goldenCase,
      item.answer,
      options,
    );

    results.push({
      goldenCase: item.goldenCase,
      answer: item.answer,
      label: item.label,
      judgeResult,
    });
  }

  return results;
}
