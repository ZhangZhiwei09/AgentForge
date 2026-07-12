// ChatAgent Persona A/B 评测脚本
//
// 用法：
//   npx tsx eval/chat-persona/run-ab-eval.ts              # 评估当前 persona
//   npx tsx eval/chat-persona/run-ab-eval.ts --judge      # 包含 LLM Judge 评分
//   npx tsx eval/chat-persona/run-ab-eval.ts --compare results/prev.json  # A/B 对比
//
// 流程：
//   1. 加载 Golden Cases → 构建 system prompt → 调用真实 LLM
//   2. Layer 1 确定性检查：requiredText / forbiddenText / maxLength
//   3. Layer 2 LLM Judge（可选）：按 judgeRubric 维度 1-5 打分
//   4. 生成报告并保存到 logs/eval/

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import OpenAI from "openai";

// 加载 .env
const envPath = path.resolve(
  import.meta.dirname || __dirname,
  "../../.env",
);
dotenv.config({ path: envPath });

import {
  GOLDEN_CASES,
  summarizeCoverage,
  type GoldenTestCase,
} from "./golden-cases.js";
import {
  AGENTFORGE_PERSONA,
  buildChatSystemPrompt,
  type Persona,
} from "@agentforge/shared-prompts";
import { evaluateResponse, type JudgeResult } from "./judge.js";

// ═══════════════════════════════════════════
// 配置：从 .env 读取
// ═══════════════════════════════════════════

const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_URL =
  process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "deepseek-chat";
// Judge 模型：优先用更便宜的模型
const JUDGE_MODEL = process.env.JUDGE_MODEL || DEFAULT_MODEL;

// ═══════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════

interface DetCheckResult {
  criterion: string;
  passed: boolean;
  failures: string[];
}

interface CaseEvalResult {
  goldenCase: GoldenTestCase;
  answer: string;
  /** Layer 1 确定性检查结果 */
  detChecks: DetCheckResult[];
  detPassed: boolean;
  /** Layer 2 Judge 评估结果（仅 --judge 模式） */
  judgeResult?: JudgeResult;
  latencyMs: number;
  modelUsed: string;
}

interface EvalReport {
  timestamp: string;
  personaVersion: string;
  model: string;
  judgeEnabled: boolean;
  totalCases: number;
  detPassed: number;
  judgePassed?: number;
  results: CaseEvalResult[];
}

// ═══════════════════════════════════════════
// LLM 调用
// ═══════════════════════════════════════════

async function callChatAgent(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 512,
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content?.trim() || "";

  // 尝试解析 JSON 提取 answer 字段
  try {
    let clean = raw;
    if (clean.startsWith("```")) {
      const parts = clean.split("```");
      clean = parts[1] || parts[0] || "";
      if (clean.startsWith("json")) clean = clean.slice(4);
      clean = clean.trim();
    }
    const parsed = JSON.parse(clean);
    return parsed.answer || raw;
  } catch {
    // JSON 解析失败 → 返回原始文本
    return raw;
  }
}

// ═══════════════════════════════════════════
// Layer 1 确定性检查
// ═══════════════════════════════════════════

function runDetChecks(
  goldenCase: GoldenTestCase,
  answer: string,
): DetCheckResult[] {
  return goldenCase.expectedBehaviors.map((behavior) => {
    const failures: string[] = [];

    // requiredText：子串匹配（忽略大小写）
    for (const phrase of behavior.requiredText ?? []) {
      if (!answer.toLowerCase().includes(phrase.toLowerCase())) {
        failures.push(`缺少必须内容: "${phrase}"`);
      }
    }

    // forbiddenText：反子串匹配
    for (const phrase of behavior.forbiddenText ?? []) {
      if (answer.toLowerCase().includes(phrase.toLowerCase())) {
        failures.push(`命中禁止内容: "${phrase}"`);
      }
    }

    // maxLength：长度检查
    if (behavior.maxLength && answer.length > behavior.maxLength) {
      failures.push(
        `回答过长: ${answer.length} 字符 (上限 ${behavior.maxLength})`,
      );
    }

    return {
      criterion: behavior.criterion,
      passed: failures.length === 0,
      failures,
    };
  });
}

// ═══════════════════════════════════════════
// CLI 参数解析
// ═══════════════════════════════════════════

function parseArgs(): {
  judge: boolean;
  compare: string | null;
  model: string | null;
} {
  const args = process.argv.slice(2);
  let judge = false;
  let compare: string | null = null;
  let model: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--judge") {
      judge = true;
    } else if (args[i] === "--compare" && i + 1 < args.length) {
      compare = args[i + 1];
      i++;
    } else if (args[i] === "--model" && i + 1 < args.length) {
      model = args[i + 1];
      i++;
    }
  }

  return { judge, compare, model };
}

// ═══════════════════════════════════════════
// 报告输出
// ═══════════════════════════════════════════

function printHeader(persona: Persona): void {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   ChatAgent Persona 质量评测              ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log("");
  console.log(`Persona: ${persona.name} (v${persona.version})`);
  const coverage = summarizeCoverage();
  console.log(`Golden Cases: ${coverage.totalCases} 个`);
  console.log(
    `  分类: identity=${coverage.byCategory.identity || 0}, capability=${coverage.byCategory.capability || 0}, boundary=${coverage.byCategory.boundary || 0}, diagnosis=${coverage.byCategory.diagnosis || 0}, edge_case=${coverage.byCategory.edge_case || 0}`,
  );
  console.log("");
}

function printCaseResult(
  index: number,
  total: number,
  result: CaseEvalResult,
  judgeEnabled: boolean,
): void {
  const detStatus = result.detPassed ? "✅" : "❌";
  const judgeStatus = result.judgeResult
    ? result.judgeResult.overallVerdict === "PASS"
      ? "✅"
      : "❌"
    : "—";

  console.log(
    `[${String(index).padStart(2)}/${total}] ${detStatus} ${result.goldenCase.name}`,
  );
  console.log(
    `     类别: ${result.goldenCase.category} | 延迟: ${result.latencyMs}ms | 模型: ${result.modelUsed}`,
  );
  console.log(
    `     Q: ${result.goldenCase.input.slice(0, 80)}${result.goldenCase.input.length > 80 ? "..." : ""}`,
  );
  console.log(
    `     A: ${result.answer.slice(0, 120)}${result.answer.length > 120 ? "..." : ""}`,
  );

  // 确定性检查失败详情
  const failedChecks = result.detChecks.filter((c) => !c.passed);
  if (failedChecks.length > 0) {
    for (const check of failedChecks) {
      console.log(`     ❌ ${check.criterion}: ${check.failures.join("; ")}`);
    }
  }

  // Judge 结果
  if (result.judgeResult && result.judgeResult.dimensions) {
    const dims = Object.entries(result.judgeResult.dimensions);
    if (dims.length > 0) {
      const dimStr = dims
        .map(([name, d]) => `${name}: ${d.score}/5`)
        .join(", ");
      const issues =
        result.judgeResult.issues.length > 0
          ? ` | 问题: ${result.judgeResult.issues.join("; ")}`
          : "";
      console.log(
        `     📊 Judge ${judgeStatus} | ${dimStr}${issues}`,
      );
    }
  }

  console.log("");
}

function printSummary(report: EvalReport): void {
  console.log("═".repeat(60));
  console.log("                质量门禁报告");
  console.log("═".repeat(60));
  console.log("");

  const { totalCases, detPassed, judgePassed } = report;

  console.log("┌──────────────────────────┬──────────┬──────────┐");
  console.log("│         指标             │  目标值  │  实测值  │");
  console.log("├──────────────────────────┼──────────┼──────────┤");
  console.log(
    `│ 确定性检查通过率          │  > 90%   │  ${((detPassed / totalCases) * 100).toFixed(1)}%   │`,
  );
  if (judgePassed !== undefined) {
    console.log(
      `│ Judge 评分通过率          │  > 80%   │  ${((judgePassed / totalCases) * 100).toFixed(1)}%   │`,
    );
  }
  const avgLatency = Math.round(
    report.results.reduce((s, r) => s + r.latencyMs, 0) / totalCases,
  );
  console.log(
    `│ 平均响应时间              │  < 5s    │  ${(avgLatency / 1000).toFixed(1)}s   │`,
  );

  // 按分类统计
  const byCategory: Record<string, { total: number; passed: number }> = {};
  for (const r of report.results) {
    const cat = r.goldenCase.category;
    if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0 };
    byCategory[cat].total++;
    if (r.detPassed) byCategory[cat].passed++;
  }

  for (const [cat, stats] of Object.entries(byCategory)) {
    const pct = ((stats.passed / stats.total) * 100).toFixed(0);
    console.log(
      `│ ${cat.padEnd(24)} │          │  ${pct}%    │`,
    );
  }

  console.log("└──────────────────────────┴──────────┴──────────┘");
  console.log("");
}

// ═══════════════════════════════════════════
// A/B 对比
// ═══════════════════════════════════════════

function printABCompare(current: EvalReport, previous: EvalReport): void {
  console.log("═".repeat(60));
  console.log("              A/B 对比报告");
  console.log("═".repeat(60));
  console.log("");
  console.log(
    `  Baseline: ${previous.timestamp} (persona v${previous.personaVersion})`,
  );
  console.log(
    `  Current:  ${current.timestamp} (persona v${current.personaVersion})`,
  );
  console.log("");

  // 按 case name 建立索引
  const prevMap = new Map(previous.results.map((r) => [r.goldenCase.name, r]));
  const currMap = new Map(current.results.map((r) => [r.goldenCase.name, r]));

  const allCaseNames = Array.from(
    new Set(Array.from(prevMap.keys()).concat(Array.from(currMap.keys()))),
  );

  let improved = 0;
  let regressed = 0;
  let unchanged = 0;

  console.log(
    "┌────────────────────────────────────┬──────────┬──────────┬──────────┐",
  );
  console.log(
    "│ Case                               │  旧      │  新      │  变化    │",
  );
  console.log(
    "├────────────────────────────────────┼──────────┼──────────┼──────────┤",
  );

  for (const name of allCaseNames) {
    const prev = prevMap.get(name);
    const curr = currMap.get(name);

    const prevPassed = prev?.detPassed ?? false;
    const currPassed = curr?.detPassed ?? false;

    let change: string;
    if (!prev) {
      change = "新增";
    } else if (!curr) {
      change = "删除";
    } else if (prevPassed && currPassed) {
      change = "—";
      unchanged++;
    } else if (!prevPassed && currPassed) {
      change = "▲ 改进";
      improved++;
    } else if (prevPassed && !currPassed) {
      change = "▼ 回归";
      regressed++;
    } else {
      change = "—";
      unchanged++;
    }

    const prevLabel = prev
      ? prev.detPassed
        ? "✅"
        : "❌"
      : "—";
    const currLabel = curr
      ? curr.detPassed
        ? "✅"
        : "❌"
      : "—";

    const displayName =
      name.length > 34 ? name.slice(0, 31) + "..." : name.padEnd(34);

    console.log(
      `│ ${displayName} │ ${prevLabel}        │ ${currLabel}        │ ${change.padEnd(8)} │`,
    );
  }

  console.log(
    "└────────────────────────────────────┴──────────┴──────────┴──────────┘",
  );
  console.log("");
  console.log(
    `总计: ${improved} 改进, ${regressed} 回归, ${unchanged} 无变化`,
  );
  console.log("");
}

// ═══════════════════════════════════════════
// 主评测流程
// ═══════════════════════════════════════════

async function runEval(): Promise<void> {
  const { judge: judgeEnabled, compare: compareFile, model: modelOverride } = parseArgs();

  // ── 初始化 Persona & Prompt ──
  const persona = AGENTFORGE_PERSONA;
  const systemPrompt = buildChatSystemPrompt(persona);

  printHeader(persona);

  // ── 初始化 LLM 客户端 ──
  const useDeepSeek =
    DEFAULT_MODEL === "deepseek-chat" && DEEPSEEK_KEY && !modelOverride;
  let client: OpenAI;
  let model: string;

  if (modelOverride) {
    // 用户指定模型 → 用第一个可用的 API Key
    if (OPENAI_KEY) {
      client = new OpenAI({ apiKey: OPENAI_KEY, baseURL: OPENAI_URL });
    } else if (DEEPSEEK_KEY) {
      client = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: DEEPSEEK_URL });
    } else {
      console.error("❌ 没有可用的 API Key，请检查 .env");
      process.exit(1);
    }
    model = modelOverride;
    console.log(`[配置] 模型: ${model} (用户指定)`);
  } else if (useDeepSeek) {
    client = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: DEEPSEEK_URL });
    model = "deepseek-chat";
    console.log(`[配置] 模型: deepseek-chat`);
  } else if (OPENAI_KEY) {
    client = new OpenAI({ apiKey: OPENAI_KEY, baseURL: OPENAI_URL });
    model = DEFAULT_MODEL;
    console.log(`[配置] 模型: ${model}`);
  } else {
    console.error("❌ 没有可用的 API Key，请检查 .env");
    process.exit(1);
  }

  // Judge 客户端（可能和主模型不同）
  let judgeClient: OpenAI;
  let judgeModel: string;
  if (judgeEnabled) {
    if (DEEPSEEK_KEY) {
      judgeClient = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: DEEPSEEK_URL });
      judgeModel = JUDGE_MODEL || "deepseek-chat";
    } else {
      judgeClient = client;
      judgeModel = model;
    }
    console.log(`[配置] Judge 模型: ${judgeModel}`);
  }

  console.log(`[配置] Judge: ${judgeEnabled ? "启用" : "禁用（仅确定性检查）"}`);
  console.log(`[配置] Golden Cases: ${GOLDEN_CASES.length} 个`);
  console.log("");
  console.log("─".repeat(60));
  console.log("");

  // ── 执行评测 ──
  const results: CaseEvalResult[] = [];

  for (let i = 0; i < GOLDEN_CASES.length; i++) {
    const goldenCase = GOLDEN_CASES[i];
    const startTime = Date.now();

    process.stdout.write(
      `[${String(i + 1).padStart(2)}/${GOLDEN_CASES.length}] ${goldenCase.name}... `,
    );

    let answer = "";
    let detChecks: DetCheckResult[] = [];
    let detPassed = false;
    let judgeResult: JudgeResult | undefined;

    try {
      // 处理空消息 edge case —— 直接使用 fallback
      if (goldenCase.input === "") {
        answer = "你好，有什么可以帮助你的？"; // ChatAgent fallback
      } else {
        answer = await callChatAgent(client, model, systemPrompt, goldenCase.input);
      }

      // Layer 1: 确定性检查
      detChecks = runDetChecks(goldenCase, answer);
      detPassed = detChecks.every((c) => c.passed);

      // Layer 2: LLM Judge
      if (judgeEnabled) {
        judgeResult = await evaluateResponse(
          judgeClient!,
          judgeModel!,
          goldenCase,
          answer,
        );
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      answer = `[ERROR] ${msg}`;
      detChecks = [
        {
          criterion: "llm-call",
          passed: false,
          failures: [`LLM 调用失败: ${msg}`],
        },
      ];
      detPassed = false;
    }

    const latencyMs = Date.now() - startTime;
    const status = detPassed ? "✅" : "❌";
    console.log(`${status} ${latencyMs}ms`);

    results.push({
      goldenCase,
      answer,
      detChecks,
      detPassed,
      judgeResult,
      latencyMs,
      modelUsed: model,
    });
  }

  console.log("");

  // ── 输出详细结果 ──
  for (let i = 0; i < results.length; i++) {
    printCaseResult(i + 1, results.length, results[i], judgeEnabled);
  }

  // ── 输出汇总 ──
  const detPassedCount = results.filter((r) => r.detPassed).length;

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    personaVersion: persona.version,
    model,
    judgeEnabled,
    totalCases: results.length,
    detPassed: detPassedCount,
    judgePassed: judgeEnabled
      ? results.filter(
          (r) => r.judgeResult?.overallVerdict === "PASS",
        ).length
      : undefined,
    results,
  };

  printSummary(report);

  // ── A/B 对比 ──
  if (compareFile) {
    try {
      const prevRaw = fs.readFileSync(compareFile, "utf-8");
      const previous = JSON.parse(prevRaw) as EvalReport;
      printABCompare(report, previous);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.log(`⚠ 无法加载对比文件 ${compareFile}: ${msg}`);
    }
  }

  // ── 保存结果 ──
  const resultsDir = path.resolve(
    import.meta.dirname || __dirname,
    "../../logs/eval",
  );
  fs.mkdirSync(resultsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsFile = path.join(
    resultsDir,
    `chat-persona-eval-${timestamp}.json`,
  );
  fs.writeFileSync(resultsFile, JSON.stringify(report, null, 2), "utf-8");
  console.log(`详细结果已保存到: ${resultsFile}`);

  // 同时追加到 JSONL（便于追踪历史趋势）
  const jsonlFile = path.join(resultsDir, "chat-persona-eval-history.jsonl");
  const jsonlEntry = {
    timestamp: report.timestamp,
    personaVersion: report.personaVersion,
    model: report.model,
    judgeEnabled: report.judgeEnabled,
    detPassed: report.detPassed,
    detRate: ((report.detPassed / report.totalCases) * 100).toFixed(1),
    judgePassed: report.judgePassed,
    judgeRate: report.judgePassed !== undefined
      ? ((report.judgePassed / report.totalCases) * 100).toFixed(1)
      : null,
    avgLatencyMs: Math.round(
      report.results.reduce((s, r) => s + r.latencyMs, 0) / report.totalCases,
    ),
  };
  fs.appendFileSync(jsonlFile, JSON.stringify(jsonlEntry) + "\n", "utf-8");
  console.log(`历史记录已追加到: ${jsonlFile}`);

  // ── 退出码 ──
  const passRate = detPassedCount / results.length;
  if (passRate < 0.8) {
    console.log(
      `\n⚠ 确定性检查通过率 ${(passRate * 100).toFixed(1)}% 低于 80% 阈值`,
    );
    process.exit(1);
  }

  console.log(`\n✅ 评测完成`);
}

runEval().catch((e) => {
  console.error("评测运行失败:", e);
  process.exit(1);
});
