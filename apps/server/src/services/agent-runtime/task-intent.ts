// TaskIntentClassifier —— TASK 路由内部轻量意图识别
//
// 在 ReAct 循环之前做一次快速分类，区分：
//   - simple_qa：单次知识库查询即可回答的简单问题
//   - complex_task：需要多工具编排、多步推理的复杂任务
//
// 设计原则：
//   1. Regex 优先（零延迟、零成本），覆盖 80% 的简单问答
//   2. LLM 兜底（廉价模型），处理边界情况
//   3. simple_qa 默认真（安全侧：宁可多走简单路径，不到万不得已不进 ReAct）
//
// 分类指标：
//   - simple_qa: 问"是什么""条件""规则""时间"等事实型问题
//   - complex_task: 涉及比较、计算、多步操作、跨文档推理

import { getProvider, resolveModel } from "../../providers/registry.js";
import { logger } from "@agentforge/logger";
import { settings } from "../../config.js";

// ── 类型 ──────────────────────────────────────────────────

export type TaskSubclass = "simple_qa" | "complex_task";

export interface TaskIntentResult {
  subclass: TaskSubclass;
  confidence: number; // 0.0 ~ 1.0
  reasoning: string;
}

// ── Regex 快速分类 ────────────────────────────────────────

// simple_qa 特征（任一命中即倾向 simple_qa）：
const SIMPLE_QA_PATTERNS = [
  // 单事实查询：是什么/什么是/是什么意思
  /^(什么是|什么是|啥是|什么是|什么叫|啥叫)/,
  /(是什么意思|是什么东西|指什么)/,
  // 条件/规则查询
  /(需要什么条件|有什么条件|条件是|要什么条件)/,
  /(需要哪些|需要什么|要哪些|要什么)(材料|证件|证明|手续)/,
  // 存在性查询（有无/是否/能不能）
  /^(有|有没有|是否有|是不是|能不能|可不可以|是否|支持|支不支持)/,
  /(可以吗|行吗|能吗|对吗|是吗)\s*[?？]*$/,
  // 单一属性查询
  /(多少钱|价格|费用|收费标准)/,
  /(营业时间|上班时间|工作时间|几点开门|几点关门)/,
  /(地址|在哪里|怎么去|位置)/,
  // 单一实体查询
  /(联系方式|电话|邮箱|客服微信)/,
  // 简单列举（单一维度）
  /(有哪些|什么类型|几种|几类|分类)/,
];

// complex_task 特征（任一命中即倾向 complex_task）：
const COMPLEX_TASK_PATTERNS = [
  // 跨文档/多实体比较
  /(对比|比较|区别|差异|不同|vs|和.*相比)/,
  /(哪个更好|哪个更划算|哪个更合适|推荐.*还是)/,
  // 多步操作
  /(帮我|替我|代我).*(办|处理|操作|修改|取消|退|换|申请)/,
  /(先.*然后|先.*再|第一步.*第二步)/,
  // 涉及订单/交易的具体操作
  /(我的订单|查.*订单|订单.*状态|物流.*进度|退.*款.*进度)/,
  /(近.*[三兩3几].*[笔单].*订单)/,
  // 组合条件推理
  /(如果.*会|假如.*怎么|万一.*该)/,
  // 需要计算
  /(帮我算|计算|总和|总共|合计|一共)/,
  // 多轮/上下文依赖（需结合历史）
  /(刚才|之前|上面|前面).*(那个|这个|说的)/,
  // 开放性分析
  /(分析|评估|总结|汇总|梳理|帮我看看)/,
];

/**
 * Regex 快速扫描：检测 simple_qa 或 complex_task 特征。
 * 返回 null 表示无法确定，需走 LLM 分类。
 */
function quickTaskScan(message: string): TaskIntentResult | null {
  // complex_task 优先 —— 一旦命中复杂特征，不走简单路径
  for (const pattern of COMPLEX_TASK_PATTERNS) {
    if (pattern.test(message)) {
      return {
        subclass: "complex_task",
        confidence: 0.85,
        reasoning: "复杂任务关键词命中",
      };
    }
  }

  // simple_qa 检查
  let simpleHits = 0;
  for (const pattern of SIMPLE_QA_PATTERNS) {
    if (pattern.test(message)) simpleHits++;
  }

  if (simpleHits >= 1) {
    const confidence = Math.min(0.7 + simpleHits * 0.1, 0.95);
    return {
      subclass: "simple_qa",
      confidence,
      reasoning: `简单问答关键词命中（${simpleHits}个模式匹配）`,
    };
  }

  return null; // → LLM 分类
}

// ── LLM 分类 ──────────────────────────────────────────────

const TASK_INTENT_PROMPT = `你是一个任务复杂度分类器。判断用户问题属于哪一类：

## simple_qa（简单问答）
单次知识库查询即可回答。特征：
- 问定义、规则、条件、价格、时间、地点
- 单一事实，"是什么/有没有/能不能"类问题
- 不需要跨文档比较或计算

## complex_task（复杂任务）
需要多步推理或工具编排。特征：
- 对比/分析/推荐/总结
- 涉及具体订单/账户操作
- 需要先查A再根据A的结果查B
- 多条件组合判断

## 输出格式（仅 JSON）
{"subclass":"simple_qa","confidence":0.9,"reasoning":"简短分析"}`;

const TASK_INTENT_SCHEMA = {
  type: "object" as const,
  properties: {
    subclass: { type: "string" as const, enum: ["simple_qa", "complex_task"] },
    confidence: { type: "number" as const, minimum: 0, maximum: 1 },
    reasoning: { type: "string" as const, maxLength: 100 },
  },
  required: ["subclass", "confidence", "reasoning"],
};

// ── 分类器 ────────────────────────────────────────────────

export class TaskIntentClassifier {
  /**
   * 对用户消息做 TASK 内部子分类。
   *
   * 流程：
   * 1. Regex 快速扫描（零延迟）
   * 2. 不确定 → LLM 分类（廉价模型，~30 token 输出）
   * 3. LLM 失败 → 默认 simple_qa（安全侧：宁可简答不破坏体验）
   */
  async classify(message: string): Promise<TaskIntentResult> {
    // ── 1. Regex 快速扫描 ──
    const quickResult = quickTaskScan(message);
    if (quickResult) {
      return quickResult;
    }

    // ── 2. LLM 分类 ──
    try {
      const { providerName, modelId: model } = resolveModel(
        settings.taskIntentModel || settings.defaultModel,
      );

      const provider = getProvider(providerName);
      const result = await provider.chatSync(
        [{ role: "user", content: message }],
        model,
        TASK_INTENT_PROMPT,
        0.0, // temperature = 0
        80,  // maxTokens（足够 JSON 输出）
        true, // jsonMode
      );

      // 解析 JSON
      const parsed = this.parseResult(result.content);
      if (parsed && parsed.confidence >= 0.5) {
        return parsed;
      }

      logger.debug(
        { confidence: parsed?.confidence, raw: result.content.slice(0, 100) },
        "TaskIntentClassifier: LLM low confidence, defaulting to simple_qa",
      );
    } catch (e) {
      logger.warn(e, "TaskIntentClassifier: LLM call failed, defaulting to simple_qa");
    }

    // ── 3. 默认 simple_qa（安全侧）──
    return {
      subclass: "simple_qa",
      confidence: 0.3,
      reasoning: "LLM 分类失败，默认 simple_qa",
    };
  }

  private parseResult(raw: string): TaskIntentResult | null {
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

      const obj = JSON.parse(jsonMatch[0]);
      if (
        typeof obj.subclass === "string" &&
        (obj.subclass === "simple_qa" || obj.subclass === "complex_task") &&
        typeof obj.confidence === "number" &&
        obj.confidence >= 0 &&
        obj.confidence <= 1
      ) {
        return {
          subclass: obj.subclass,
          confidence: obj.confidence,
          reasoning: String(obj.reasoning || "").slice(0, 100),
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}

// 单例
let classifierInstance: TaskIntentClassifier | undefined;

export function getTaskIntentClassifier(): TaskIntentClassifier {
  if (!classifierInstance) {
    classifierInstance = new TaskIntentClassifier();
  }
  return classifierInstance;
}
