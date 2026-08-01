// Agent Guard Service —— Agent 级安全围栏
// 在 Agent 决策和工具执行之间插入安全校验层：
//   1. 工具权限控制（allowlist/denylist）
//   2. Token 预算硬限制
//   3. 成本预算（按模型费率估算）
//   4. PII/敏感信息检测与脱敏
//   5. 内容安全检查（复用 content-safety 中间件逻辑）
import { logger } from "@agentforge/logger";
import { estimateTokenCount } from "../lib/context-window.js";

// ---- Types ----

export interface AgentGuardConfig {
  /** Token 消耗硬上限 */
  maxTokens: number;
  /** 成本上限（美分） */
  maxCostCents: number;
  /** 工具白名单（空 = 全部允许） */
  allowedTools: string[];
  /** 工具黑名单（优先级高于白名单） */
  deniedTools: string[];
  /** 是否启用 PII 检测 */
  piiDetectionEnabled: boolean;
  /** 是否启用内容安全检查 */
  contentSafetyEnabled: boolean;
}

export const DEFAULT_GUARD_CONFIG: AgentGuardConfig = {
  maxTokens: 50000,
  maxCostCents: 200, // $2.00
  allowedTools: [],
  deniedTools: [],
  piiDetectionEnabled: true,
  contentSafetyEnabled: true,
};

// ---- 模型费率表（美分/1K tokens） ----

const MODEL_RATES: Record<string, { prompt: number; completion: number }> = {
  "deepseek-v3": { prompt: 0.027, completion: 0.11 },
  "deepseek-r1": { prompt: 0.055, completion: 0.22 },
  "deepseek-v4-flash": { prompt: 0.014, completion: 0.055 },
  "deepseek-chat": { prompt: 0.027, completion: 0.11 },
  "gpt-4o": { prompt: 0.25, completion: 1.0 },
  "gpt-4o-mini": { prompt: 0.015, completion: 0.06 },
  "gpt-4-turbo": { prompt: 1.0, completion: 3.0 },
  "claude-sonnet-4-20250514": { prompt: 0.3, completion: 1.5 },
  "claude-fable-5": { prompt: 0.3, completion: 1.5 },
};

// ---- PII 检测模式 ----

const PII_PATTERNS: Array<{
  name: string;
  regex: RegExp;
  description: string;
}> = [
  // 中国身份证号（18位）
  {
    name: "cn_id_card",
    regex: /\b\d{17}[\dXx]\b/,
    description: "中国身份证号",
  },
  // 中国手机号
  { name: "cn_phone", regex: /\b1[3-9]\d{9}\b/, description: "中国手机号" },
  // 中国固定电话
  {
    name: "cn_landline",
    regex: /\b0\d{2,3}[-\s]?\d{7,8}\b/,
    description: "中国固定电话",
  },
  // 邮箱地址
  {
    name: "email",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    description: "邮箱地址",
  },
  // 银行卡号（16-19位）
  { name: "bank_card", regex: /\b\d{16,19}\b/, description: "银行卡号" },
  // IP 地址
  {
    name: "ip_address",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
    description: "IP地址",
  },
  // API Key 模式
  {
    name: "api_key",
    regex:
      /\b(sk-[a-zA-Z0-9]{20,})|(key-[a-zA-Z0-9]{20,})|(api[_-]?key[=:]\s*['"]?\w{10,})/i,
    description: "API密钥",
  },
  // 密码字段
  {
    name: "password",
    regex: /(?:password|passwd|pwd|secret)\s*[:=]\s*['"]?\S+['"]?/i,
    description: "密码信息",
  },
  // 家庭住址（中文）
  {
    name: "cn_address",
    regex: /(?:省|市|区|县|街道|路|号|栋|单元|室).{3,30}(?:省|市|区|县)/,
    description: "中国地址",
  },
  // 车牌号
  {
    name: "cn_plate",
    regex:
      /\b[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼宁][A-Z][A-HJ-NP-Z0-9]{4,5}[A-HJ-NP-Z0-9挂学警港澳]\b/,
    description: "中国车牌号",
  },
];

// ---- 内容安全注入检测（简化版，复用 content-safety 模式） ----

const CONTENT_SAFETY_PATTERNS: RegExp[] = [
  /ignore all previous instructions/i,
  /disregard (?:prior|earlier|all) instructions/i,
  /you are now a different/i,
  /new system prompt/i,
  /reveal (?:your|the) (?:system )?prompt/i,
  /show me your (?:system )?prompt/i,
  /\[system\]/i,
  /<\|system\|>/i,
  /DAN mode/i,
  /developer mode/i,
  /jailbreak/i,
];

// ---- Agent Guard Service ----

export class AgentGuardService {
  private config: AgentGuardConfig;

  constructor(config: Partial<AgentGuardConfig> = {}) {
    this.config = { ...DEFAULT_GUARD_CONFIG, ...config };
  }

  // ========== 工具权限 ==========

  /**
   * 校验工具调用是否被允许。
   */
  validateToolCall(
    toolName: string,
    _args: Record<string, unknown>,
  ): { allowed: boolean; reason?: string } {
    // 黑名单优先
    if (
      this.config.deniedTools.length > 0 &&
      this.config.deniedTools.includes(toolName)
    ) {
      return {
        allowed: false,
        reason: `工具 "${toolName}" 已被管理员禁用`,
      };
    }

    // 白名单（非空时才生效）
    if (
      this.config.allowedTools.length > 0 &&
      !this.config.allowedTools.includes(toolName)
    ) {
      return {
        allowed: false,
        reason: `工具 "${toolName}" 不在允许列表中。可用工具：${this.config.allowedTools.join(", ")}`,
      };
    }

    return { allowed: true };
  }

  // ========== Token 预算 ==========

  /**
   * 检查 token 预算是否超限。
   */
  checkTokenBudget(
    tokensUsed: number,
    tokensAboutToUse: number = 0,
  ): { ok: boolean; remaining: number; exceeded: boolean } {
    const remaining = this.config.maxTokens - tokensUsed - tokensAboutToUse;
    return {
      ok: remaining > 0,
      remaining: Math.max(0, remaining),
      exceeded: remaining <= 0,
    };
  }

  /**
   * 估算文本的 token 数量。
   */
  estimateTokens(text: string): number {
    return estimateTokenCount([{ role: "user", content: text }]);
  }

  // ========== 成本预算 ==========

  /**
   * 获取模型的费率（美分/1K tokens）。
   */
  getModelRate(model: string): { prompt: number; completion: number } {
    // 尝试精确匹配
    if (MODEL_RATES[model]) return MODEL_RATES[model];

    // 前缀匹配
    for (const [key, rate] of Object.entries(MODEL_RATES)) {
      if (model.startsWith(key)) return rate;
    }

    // 默认：中等费率
    return { prompt: 0.1, completion: 0.5 };
  }

  /**
   * 估算 LLM 调用的成本（美分）。
   */
  estimateCost(
    promptTokens: number,
    completionTokens: number,
    model: string,
  ): number {
    const rate = this.getModelRate(model);
    return (
      (promptTokens / 1000) * rate.prompt +
      (completionTokens / 1000) * rate.completion
    );
  }

  /**
   * 检查成本预算。
   */
  checkCostBudget(
    costCentsUsed: number,
    model: string,
    estimatedPromptTokens: number,
    estimatedCompletionTokens: number = 0,
  ): { ok: boolean; remainingCents: number; estimatedCost: number } {
    const estimatedCost = this.estimateCost(
      estimatedPromptTokens,
      estimatedCompletionTokens,
      model,
    );
    const remainingCents =
      this.config.maxCostCents - costCentsUsed - estimatedCost;
    return {
      ok: remainingCents > 0,
      remainingCents,
      estimatedCost,
    };
  }

  // ========== PII 检测 ==========

  /**
   * 扫描内容中的敏感信息。
   */
  scanForPII(content: string): {
    hasPII: boolean;
    findings: string[];
    maskedContent: string;
  } {
    if (!this.config.piiDetectionEnabled) {
      return { hasPII: false, findings: [], maskedContent: content };
    }

    const findings: string[] = [];
    let maskedContent = content;

    for (const pattern of PII_PATTERNS) {
      const matches = content.match(pattern.regex);
      if (matches) {
        findings.push(`发现${pattern.description}: ${matches.length}处`);
        // 脱敏：用 *** 替换匹配内容
        maskedContent = maskedContent.replace(pattern.regex, (match) => {
          const len = match.length;
          if (len <= 4) return "***";
          return match.slice(0, 2) + "***" + match.slice(-2);
        });
      }
    }

    if (findings.length > 0) {
      logger.warn({ piiFindings: findings }, "PII detected in agent output");
    }

    return {
      hasPII: findings.length > 0,
      findings,
      maskedContent,
    };
  }

  // ========== 内容安全 ==========

  /**
   * 检查内容是否包含注入攻击模式。
   */
  checkContentSafety(content: string): { safe: boolean; reason?: string } {
    if (!this.config.contentSafetyEnabled) {
      return { safe: true };
    }

    for (const pattern of CONTENT_SAFETY_PATTERNS) {
      if (pattern.test(content)) {
        const reason = `检测到提示注入模式: ${pattern.source}`;
        logger.warn(
          { pattern: pattern.source },
          "Content safety violation in agent",
        );
        return { safe: false, reason };
      }
    }

    return { safe: true };
  }

  // ========== 综合决策守卫 ==========

  /**
   * 对 Agent 的一个完整决策进行安全检查。
   * 在工具执行前调用。
   */
  guardToolCall(
    toolName: string,
    args: Record<string, unknown>,
    tokensUsed: number,
    costCentsUsed: number,
    model: string,
  ): {
    allowed: boolean;
    blockReason?: string;
    tokenBudgetExceeded?: boolean;
    costBudgetExceeded?: boolean;
  } {
    // 1. 工具权限
    const toolCheck = this.validateToolCall(toolName, args);
    if (!toolCheck.allowed) {
      return { allowed: false, blockReason: toolCheck.reason };
    }

    // 2. Token 预算
    const tokenCheck = this.checkTokenBudget(tokensUsed, 1000); // 预估工具调用消耗 ~1K tokens
    if (tokenCheck.exceeded) {
      return {
        allowed: false,
        blockReason: `Token 预算已耗尽（${tokensUsed}/${this.config.maxTokens}），请要求 Agent 总结并回复`,
        tokenBudgetExceeded: true,
      };
    }

    // 3. 成本预算
    const costCheck = this.checkCostBudget(costCentsUsed, model, 0, 500); // 预估完成 ~500 tokens
    if (!costCheck.ok) {
      return {
        allowed: false,
        blockReason: `成本预算已耗尽（$${(costCentsUsed / 100).toFixed(2)}/$${(this.config.maxCostCents / 100).toFixed(2)}）`,
        costBudgetExceeded: true,
      };
    }

    return { allowed: true };
  }

  /**
   * 对 Agent 的响应内容进行安全检查。
   * 在 yield agent_respond 之前调用。
   */
  guardResponse(content: string): {
    safe: boolean;
    piiFindings: string[];
    sanitizedContent: string;
    blockReason?: string;
  } {
    // 1. 内容安全
    const safetyCheck = this.checkContentSafety(content);
    if (!safetyCheck.safe) {
      return {
        safe: false,
        piiFindings: [],
        sanitizedContent: "[内容已被安全过滤器拦截]",
        blockReason: safetyCheck.reason,
      };
    }

    // 2. PII 检测与脱敏
    const piiResult = this.scanForPII(content);
    if (piiResult.hasPII) {
      return {
        safe: true,
        piiFindings: piiResult.findings,
        sanitizedContent: piiResult.maskedContent,
      };
    }

    return {
      safe: true,
      piiFindings: [],
      sanitizedContent: content,
    };
  }

  // ========== 预算摘要 ==========

  /**
   * 获取当前预算使用摘要（用于 frontend debug panel）。
   */
  getBudgetSummary(tokensUsed: number, costCentsUsed: number, model: string) {
    const tokenRemaining = Math.max(0, this.config.maxTokens - tokensUsed);
    const costRemaining = Math.max(
      0,
      (this.config.maxCostCents - costCentsUsed) / 100,
    );

    return {
      tokens: {
        used: tokensUsed,
        limit: this.config.maxTokens,
        remaining: tokenRemaining,
        percentUsed: Math.round((tokensUsed / this.config.maxTokens) * 100),
      },
      cost: {
        usedCents: costCentsUsed,
        limitCents: this.config.maxCostCents,
        remainingDollars: costRemaining,
        percentUsed: Math.round(
          (costCentsUsed / this.config.maxCostCents) * 100,
        ),
      },
      model,
      rate: this.getModelRate(model),
    };
  }
}
