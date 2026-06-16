// Memory Compressor —— P0-3 工作记忆管理
// 当 Agent scratchpad 超过阈值时自动压缩：保留高重要性步骤，压缩低重要性步骤为摘要
// 防止长期任务中 scratchpad 无限增长导致上下文溢出
import { logger } from "@agentforge/logger";
import type { AgentStep } from "@agentforge/shared-types";
import type { LLMProvider } from "../providers/types.js";

// ---- 常量 ----

/** scratchpad 长度超过此阈值时触发压缩 */
export const SCRATCHPAD_COMPRESSION_THRESHOLD = 5;

/** 重要性 >= 此值的步骤被完整保留 */
export const HIGH_IMPORTANCE_THRESHOLD = 7;

// ---- 类型 ----

export interface ScoredStep {
  step: AgentStep;
  score: number;
  reason: string;
}

export interface CompressionResult {
  /** 压缩摘要（中文），注入到 LLM 上下文中替代被压缩的步骤 */
  summary: string;
  /** 被保留的高重要性步骤 */
  keptSteps: AgentStep[];
  /** 被压缩的步骤数 */
  compressedCount: number;
}

// ---- Memory Compressor ----

export class MemoryCompressor {
  /**
   * 对 scratchpad 中每个步骤打分。
   *
   * 评分规则：
   *   +5: respond（最终回复）—— 最优先保留
   *   +3: 关键工具调用（file_read, db_query, web_search, web_fetch, http_request, code_execute）
   *   +3: 计划变更（analysis/plan 中包含策略调整信号）
   *   +2: ask_user（需要用户澄清）
   *   +1: 包含错误/降级的步骤
   *   -2: 辅助工具调用（calculator, get_current_time）
   *   +2: 第一个步骤（起始上下文）
   *   基础分: 10（正常步骤都能保留）
   */
  scoreImportance(scratchpad: AgentStep[]): ScoredStep[] {
    return scratchpad.map((step, index) => {
      let score = 5;
      const reasons: string[] = [];

      const action = step.decision.action;

      // respond — 最终输出，最高优先级
      if (action === "respond") {
        score += 5;
        reasons.push("最终回复");
      }

      // 工具调用 — 按工具类型评分
      if (action === "tool_call") {
        const tool = step.decision.tool;
        if (this.isCriticalTool(tool)) {
          score += 3;
          reasons.push(`关键工具:${tool}`);
        } else if (this.isTrivialTool(tool)) {
          score -= 2;
          reasons.push(`辅助工具:${tool}`);
        }
      }

      // ask_user — 重要交互节点
      if (action === "ask_user") {
        score += 2;
        reasons.push("用户澄清");
      }

      // 计划变更检测
      if (this.isPlanChange(step)) {
        score += 3;
        reasons.push("策略调整");
      }

      // 错误步骤 — 保留以供排查
      if (step.error) {
        score += 1;
        reasons.push("包含错误");
      }

      // 第一个步骤 — 起始上下文很重要
      if (index === 0) {
        score += 2;
        reasons.push("起始步骤");
      }

      // 纠正步骤（第2-3步中的错误修复也值得保留）
      if (index <= 2 && this.isErrorRecovery(step)) {
        score += 2;
        reasons.push("早期纠错");
      }

      return {
        step,
        score,
        reason: reasons.join(",") || "常规步骤",
      };
    });
  }

  /**
   * 压缩 scratchpad：保留高重要性步骤，用规则生成的摘要替代低重要性步骤。
   * 规则摘要作为 fallback，实际使用时应调用 compressWithLLM() 获取高质量摘要。
   */
  compress(scratchpad: AgentStep[]): CompressionResult {
    if (scratchpad.length <= SCRATCHPAD_COMPRESSION_THRESHOLD) {
      return {
        summary: "",
        keptSteps: scratchpad,
        compressedCount: 0,
      };
    }

    const scored = this.scoreImportance(scratchpad);

    const keptSteps = scored
      .filter((s) => s.score >= HIGH_IMPORTANCE_THRESHOLD)
      .map((s) => s.step);

    const compressed = scored.filter(
      (s) => s.score < HIGH_IMPORTANCE_THRESHOLD,
    );

    // 边界情况：全部步骤都是高重要性 → 不压缩
    if (compressed.length === 0) {
      return {
        summary: "",
        keptSteps: scratchpad,
        compressedCount: 0,
      };
    }

    // 边界情况：压缩后保留的步骤太少 → 强制保留最后2步
    if (keptSteps.length < 2 && scratchpad.length > 2) {
      const lastTwo = scratchpad.slice(-2);
      for (const s of lastTwo) {
        if (!keptSteps.find((k) => k.step === s.step)) {
          keptSteps.push(s);
        }
      }
    }

    const summary = this.generateSummary(compressed, keptSteps.length);

    return {
      summary,
      keptSteps,
      compressedCount: compressed.length,
    };
  }

  /**
   * 使用 LLM 生成高质量中文压缩摘要。
   * 温度=0（确定性），最多1次重试。
   * 失败时回退到规则生成的摘要。
   */
  async compressWithLLM(
    scratchpad: AgentStep[],
    provider: LLMProvider,
    model: string,
  ): Promise<CompressionResult> {
    const baseResult = this.compress(scratchpad);

    if (baseResult.compressedCount === 0) {
      return baseResult;
    }

    const scored = this.scoreImportance(scratchpad);
    const compressed = scored.filter(
      (s) => s.score < HIGH_IMPORTANCE_THRESHOLD,
    );

    try {
      const prompt = this.buildCompressionPrompt(compressed);
      const response = await provider.chatSync(
        [{ role: "user", content: prompt }],
        model,
        undefined, // system prompt inline
        0, // temperature=0 确保确定性
        800, // maxTokens
        false, // jsonMode
      );

      const llmSummary = response?.content?.trim();
      if (llmSummary) {
        logger.debug(
          {
            compressedCount: compressed.length,
            keptCount: baseResult.keptSteps.length,
            summaryLength: llmSummary.length,
          },
          "LLM compression generated summary",
        );
        return {
          ...baseResult,
          summary: llmSummary,
        };
      }
    } catch (err) {
      logger.warn(
        { error: err instanceof Error ? err.message : "Unknown error" },
        "LLM compression failed, using rule-based summary",
      );
    }

    return baseResult;
  }

  // ---- 私有方法 ----

  /**
   * 判断工具是否为"关键"工具（获取数据的工具）。
   */
  private isCriticalTool(toolName: string): boolean {
    const critical = [
      "file_read",
      "db_query",
      "web_search",
      "web_fetch",
      "http_request",
      "code_execute",
      "file_search",
    ];
    return critical.includes(toolName);
  }

  /**
   * 判断工具是否为"辅助"工具（简单计算、时间查询等）。
   */
  private isTrivialTool(toolName: string): boolean {
    const trivial = ["calculator", "get_current_time"];
    return trivial.includes(toolName);
  }

  /**
   * 检测步骤是否包含计划变更信号。
   */
  private isPlanChange(step: AgentStep): boolean {
    const planKeywords = [
      "改变计划",
      "调整策略",
      "换个思路",
      "重新规划",
      "新方案",
      "替代方案",
      "修正计划",
      "重新评估",
      "策略调整",
      "换一种方式",
    ];
    const analysisText = step.analysis + step.plan;
    return planKeywords.some((kw) => analysisText.includes(kw));
  }

  /**
   * 检测步骤是否为纠错/恢复步骤。
   */
  private isErrorRecovery(step: AgentStep): boolean {
    const recoveryKeywords = ["修复", "纠正", "重试", "替代", "降级", "错误"];
    const analysisText = step.analysis + step.plan;
    return (
      recoveryKeywords.some((kw) => analysisText.includes(kw)) || !!step.error
    );
  }

  /**
   * 生成规则摘要（中文）。
   */
  private generateSummary(compressed: ScoredStep[], keptCount: number): string {
    if (compressed.length === 0) return "";

    const stepNumbers = compressed.map((s) => `第${s.step.step}步`).join("、");
    const actions = compressed
      .map((s) => {
        const a = s.step.decision.action;
        if (a === "tool_call") return `调用${s.step.decision.tool}`;
        if (a === "respond") return "回复用户";
        if (a === "ask_user") return "向用户提问";
        return a;
      })
      .join(" → ");

    // 收集关键发现
    const results = compressed
      .filter((s) => s.step.result)
      .map((s) => `步骤${s.step.step}: ${s.step.result!.slice(0, 80)}`);
    const resultSection =
      results.length > 0 ? `\n关键结果:\n${results.join("\n")}` : "";

    return [
      `[压缩摘要] 以下 ${compressed.length} 个步骤已被压缩：${stepNumbers}`,
      `操作序列: ${actions}${resultSection}`,
      `\n保留 ${keptCount} 个高重要性步骤（可能包含关键决策点和最终回复）。`,
      "如有疑问请查看完整步骤记录。",
    ].join("\n");
  }

  /**
   * 构建 LLM 压缩提示词（中文）。
   */
  private buildCompressionPrompt(compressed: ScoredStep[]): string {
    const stepDetails = compressed
      .map((s) => {
        const action =
          s.step.decision.action === "tool_call"
            ? `调用工具 ${s.step.decision.tool}，原因：${(s.step.decision as { reason?: string }).reason || "未说明"}`
            : s.step.decision.action;
        const result = s.step.result
          ? `结果：${s.step.result.slice(0, 150)}`
          : "";
        return `步骤${s.step.step}: ${s.step.observation.slice(0, 150)} | ${action}${result ? ` | ${result}` : ""}`;
      })
      .join("\n");

    return [
      "你是一个 Agent 记忆压缩助手。请将以下 Agent 执行步骤压缩为一段简洁的中文摘要。",
      "",
      "要求：",
      "1. 长度不超过200字",
      "2. 保留关键操作和重要发现",
      "3. 用自然语言表达，不要编号列表",
      "4. 去掉冗余的细节",
      "",
      "待压缩步骤：",
      stepDetails,
      "",
      "摘要：",
    ].join("\n");
  }
}
