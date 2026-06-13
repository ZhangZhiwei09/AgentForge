// BusinessAgent 校验管线
// 从 CustomerChatService 中提取，用于校验 LLM 生成的业务回复质量
// 5 层校验：JSON 可解析 → Schema 校验 → 禁止行为扫描 → Citation 引证校验 → 事实性声明检查
//
// L4 已从关键词重叠升级为 CitationVerifier 的逐句语义引证校验。
// 当 embedding provider 可用时使用余弦相似度，否则回退到增强版关键词+实体匹配。
// 详见: decisions/004-tradeoffs-citation-vs-keyword.md

import { z } from "zod";
import { extractJSONFromLLMResponse } from "../../lib/json-utils.js";
import type { CitationReport } from "./citation-verifier.js";

// ── 固定话术 ──

export const SORRY_TEMPLATE =
  "抱歉，我目前没有找到相关信息，建议您联系人工客服获取帮助。";
export const FALLBACK_PREFIX =
  "以下是可能相关的知识库内容，如需更多帮助请联系人工客服：\n\n";

// ── Zod Schema ──

export const ChatResponseSchema = z.object({
  answer: z.string().min(1).max(2000),
  suggestions: z.array(z.string().max(50)).max(3).default([]),
});

export type ChatResponse = z.infer<typeof ChatResponseSchema>;

// ── Layer 3：禁止行为扫描列表 ──

export const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /根据(我司|公司|平台)规定/g, label: "虚假权威引用" },
  { pattern: /经查询[^，。]*[，。]/g, label: "虚假查询陈述" },
  { pattern: /可能是(因为|由于)/g, label: "无依据推测原因" },
  {
    pattern: /您的(订单|物流|快递)[^，。]{0,10}(可能|应该)/g,
    label: "推测客户信息",
  },
  { pattern: /建议您(自行|自己)[^，。]*[，。]/g, label: "推卸责任式建议" },
];

// ── 校验结果 ──

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  layer: number;
}

// ── 5 层校验管线（L4 已升级为 Citation-based 语义对齐） ──

export function validateBusinessResponse(
  rawText: string,
  knowledgeChunks: string[],
  citationReport?: CitationReport,
): ValidationResult {
  // Layer 1: JSON 可解析
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJSONFromLLMResponse(rawText));
  } catch {
    return { valid: false, errors: ["Layer1: JSON 不可解析"], layer: 1 };
  }

  // Layer 2: Schema 校验
  const schemaResult = ChatResponseSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    );
    return {
      valid: false,
      errors: [`Layer2: Schema校验失败 - ${issues.join("; ")}`],
      layer: 2,
    };
  }

  const data = schemaResult.data;

  // Layer 3: 禁止行为扫描
  const forbiddenHits: string[] = [];
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(data.answer)) {
      forbiddenHits.push(label);
    }
  }
  if (forbiddenHits.length > 0) {
    return {
      valid: false,
      errors: [`Layer3: 命中禁止行为 - ${forbiddenHits.join(", ")}`],
      layer: 3,
    };
  }

  // Layer 4: Citation 引证校验（软告警，不阻止）
  // 优先使用 CitationVerifier 的语义对齐结果，
  // 降级时回退到旧版关键词重叠检测
  const layer4Errors: string[] = [];

  if (knowledgeChunks.length > 0 && data.answer !== SORRY_TEMPLATE) {
    if (citationReport) {
      // ── 新版 Citation-based 语义对齐 ──
      const uncitedFactuals = citationReport.sentences.filter(
        (s) => s.isFactual && s.status === "uncited",
      );
      const weakCitations = citationReport.sentences.filter(
        (s) => s.isFactual && s.status === "weak_citation",
      );

      if (uncitedFactuals.length > 0) {
        layer4Errors.push(
          `Layer4: ${uncitedFactuals.length}个事实性句子无引证来源 [${uncitedFactuals.map((s) => s.text.slice(0, 50)).join(" | ")}]`,
        );
      }
      if (weakCitations.length > 0) {
        layer4Errors.push(
          `Layer4: ${weakCitations.length}个句子引证较弱 (coverage=${(citationReport.coverageRate * 100).toFixed(0)}%, avg_score=${citationReport.avgScore.toFixed(2)}, level=${citationReport.level})`,
        );
      }
    } else {
      // ── 旧版关键词回退（CitationVerifier 不可用时的保底） ──
      const answerLower = data.answer.toLowerCase();
      const hitCount = knowledgeChunks.filter((chunk) => {
        const keywords = chunk.match(/[一-鿿\w]{3,}/g) || [];
        return keywords.some((kw) => answerLower.includes(kw.toLowerCase()));
      }).length;
      const hitRate =
        knowledgeChunks.length > 0 ? hitCount / knowledgeChunks.length : 0;
      if (hitRate < 0.5) {
        layer4Errors.push(
          `Layer4(keyword): KB命中率过低 (${(hitRate * 100).toFixed(0)}%)`,
        );
      }
    }
  }

  // Layer 5: KB 为空但回复包含业务事实性内容 → 疑似编造
  if (knowledgeChunks.length === 0 && data.answer !== SORRY_TEMPLATE) {
    const factualIndicators = [
      /[0-9]+\s*(天|个工作日|小时|分钟)/,
      /[0-9]+\s*(元|块|折|%|折)/,
      /(退货|退款|换货|物流|快递|发货|运费)/,
      /(会员|积分|等级|优惠券|折扣)/,
    ];
    const hasFactualClaims = factualIndicators.some((p) =>
      p.test(data.answer),
    );
    if (hasFactualClaims) {
      return {
        valid: false,
        errors: ["Layer5: KB上下文为空但回复包含业务事实性内容，疑似编造"],
        layer: 5,
      };
    }
  }

  return { valid: true, errors: layer4Errors, layer: 0 };
}

// ── 解析 LLM 响应为 ChatResponse ──

export function parseChatResponse(rawText: string): ChatResponse | null {
  try {
    const parsed = JSON.parse(extractJSONFromLLMResponse(rawText));
    const result = ChatResponseSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
