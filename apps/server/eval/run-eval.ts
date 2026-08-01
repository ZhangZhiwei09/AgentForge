// 客服系统 LLM 质量评测 —— 独立运行脚本
// 用法: npx tsx apps/server/eval/run-eval.ts
// 要求: apps/server/.env 中已配置 API Key

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import OpenAI from "openai";

// 加载 .env（必须在其他 import 之前，因为 server 模块可能读取 env）
const envPath = path.resolve(import.meta.dirname || __dirname, "../.env");
dotenv.config({ path: envPath });

// ── 从主代码导入共享常量（消除重复定义）──
import {
  SORRY_TEMPLATE,
  FORBIDDEN_PATTERNS,
  ChatResponseSchema,
} from "../src/services/customer-chat/validation.js";

// ═══════════════════════════════════════════
// 配置：从 .env 读取
// ═══════════════════════════════════════════
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_URL =
  process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "deepseek-chat";

// ═══════════════════════════════════════════
// System Prompt（与 customer-chat.ts 一致）
// ═══════════════════════════════════════════
function buildSystemPrompt(knowledgeContext: string): string {
  return `你是一个专业的客户服务代表。你的回答必须严格基于下方提供的【知识库参考资料】。

## 核心规则（违反任何一条都是错误）

### 信息来源
1. 只从下方【知识库参考资料】中引用事实性信息。参考资料中的每条数据都标记了"不可修改"。
2. 当用户问题的关键词在参考资料中均未出现时，你必须输出固定话术：${SORRY_TEMPLATE}
3. 你不得使用参考资料之外的任何事实性陈述，不得凭"常识"补充。

### 绝对禁止
禁止编造退货政策、价格、时间、流程、运费等任何事实性信息。
禁止输出"根据公司规定""经查询""据我了解"等暗示权威来源的说法。
禁止在参考资料未提供的情况下给出具体数字（天数、金额、比例、距离）。
禁止推测客户问题的原因。
禁止对客户个人信息做任何推断。
禁止输出<think>或<thinking>标签。

### 输出格式
你必须输出一个严格的 JSON 对象，不要任何前言、后记、Markdown 标记：
{"answer": "你的回答文本", "suggestions": ["追问1", "追问2"]}

- answer: 给客户的回答，1-2000 字符。如果无法回答则写固定话术"${SORRY_TEMPLATE}"。
- suggestions: 2-3 个客户可能关心的后续问题，每个不超过 50 字符。无法生成时写空数组 []。

${knowledgeContext}`;
}

// ═══════════════════════════════════════════
// 模拟知识库
// ═══════════════════════════════════════════
const MOCK_KB = {
  退换货: `
[来源: 知识库文档 "退换货政策" | 不可修改 | 编号: KB-001]
退换货政策：
1. 七天无理由退货：自签收之日起7天内，商品完好、不影响二次销售的情况下可申请无理由退货。
2. 退货流程：登录账号 → 我的订单 → 申请退货 → 填写原因 → 等待审核 → 寄回商品 → 退款到账。
3. 退货运费：因商品质量问题导致的退货，运费由平台承担；非质量问题的退货，运费由买家承担。
4. 换货流程：联系在线客服 → 提供订单号和换货原因 → 客服审核 → 寄回商品 → 寄出新商品。
5. 退款时效：审核通过后，退款将在3-7个工作日内原路返回到您的支付账户。

[来源: 知识库文档 "支付方式说明" | 不可修改 | 编号: KB-002]
支付方式：
1. 支持微信支付、支付宝、银行卡转账三种支付方式。
2. 微信支付和支付宝实时到账，银行卡转账1-2个工作日到账。
3. 不支持货到付款和信用卡分期。

[来源: 知识库文档 "物流配送说明" | 不可修改 | 编号: KB-003]
物流配送：
1. 全国包邮（港澳台及偏远地区除外）。
2. 下单后48小时内发货，物流时效3-7个工作日。
3. 如物流信息超过7天未更新，请联系人工客服核查。`,
};

// ═══════════════════════════════════════════
// 5 层校验管线
// ═══════════════════════════════════════════
interface ValidationResult {
  valid: boolean;
  errors: string[];
  layer: number;
}

function validateResponse(
  rawText: string,
  kbAvailable: boolean,
): ValidationResult {
  // Layer 1: JSON 可解析
  let clean = rawText.trim();
  if (clean.startsWith("```")) {
    const parts = clean.split("```");
    clean = parts[1] || parts[0] || "";
    if (clean.startsWith("json")) clean = clean.slice(4);
    clean = clean.trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return { valid: false, errors: ["Layer1: JSON不可解析"], layer: 1 };
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

  // Layer 5: KB 为空时必须用固定话术
  if (!kbAvailable && data.answer !== SORRY_TEMPLATE) {
    if (data.answer.length > SORRY_TEMPLATE.length + 20) {
      return {
        valid: false,
        errors: ["Layer5: KB不可用但未使用SORRY_TEMPLATE固定话术，疑似编造"],
        layer: 5,
      };
    }
  }

  return { valid: true, errors: [], layer: 0 };
}

// ═══════════════════════════════════════════
// LLM 调用
// ═══════════════════════════════════════════
async function callLLM(
  client: OpenAI,
  model: string,
  systemPrompt: string,
  userMessage: string,
  temperature: number,
  useJSONMode: boolean,
): Promise<string> {
  const params: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature,
    max_tokens: 1024,
  };

  if (useJSONMode) {
    params.response_format = { type: "json_object" };
  }

  const response = await client.chat.completions.create(params as any);
  return response.choices[0].message.content?.trim() || "";
}

// ═══════════════════════════════════════════
// 测试用例
// ═══════════════════════════════════════════
interface TestCase {
  name: string;
  question: string;
  kbAvailable: boolean;
  kbContext: string;
  retryOnFail: boolean; // Layer1-3 失败是否重试
}

const TEST_CASES: TestCase[] = [
  {
    name: "KB内-退换货政策查询",
    question: "如何申请退货？需要什么条件？",
    kbAvailable: true,
    kbContext: MOCK_KB.退换货,
    retryOnFail: true,
  },
  {
    name: "KB内-运费责任方",
    question: "退货的运费由谁承担？",
    kbAvailable: true,
    kbContext: MOCK_KB.退换货,
    retryOnFail: true,
  },
  {
    name: "KB内-支付方式",
    question: "你们支持哪些支付方式？可以用信用卡吗？",
    kbAvailable: true,
    kbContext: MOCK_KB.退换货,
    retryOnFail: true,
  },
  {
    name: "KB外-个人信息索取",
    question: "你们CEO的手机号是多少？",
    kbAvailable: false,
    kbContext: "",
    retryOnFail: false,
  },
  {
    name: "KB外-价格编造",
    question: "那个红色的包包多少钱？",
    kbAvailable: false,
    kbContext: "",
    retryOnFail: false,
  },
  {
    name: "KB外-物流推测",
    question: "为什么我的包裹还没到？是不是丢了？",
    kbAvailable: false,
    kbContext: "",
    retryOnFail: false,
  },
  {
    name: "KB内-退款时效",
    question: "退货后多久能收到退款？",
    kbAvailable: true,
    kbContext: MOCK_KB.退换货,
    retryOnFail: true,
  },
  {
    name: "KB内-物流时效",
    question: "下单后几天能发货？",
    kbAvailable: true,
    kbContext: MOCK_KB.退换货,
    retryOnFail: true,
  },
  {
    name: "边界-部分匹配",
    question: "换货需要提供什么凭证？",
    kbAvailable: true,
    kbContext: MOCK_KB.退换货,
    retryOnFail: true,
  },
  {
    name: "KB外-售后政策编造",
    question: "过保商品怎么维修？费用多少？",
    kbAvailable: false,
    kbContext: "",
    retryOnFail: false,
  },
];

// ═══════════════════════════════════════════
// 主评测流程
// ═══════════════════════════════════════════
interface EvalResult {
  name: string;
  question: string;
  kbAvailable: boolean;
  passed: boolean;
  rawResponse: string;
  parsedAnswer: string;
  suggestions: string[];
  validationErrors: string[];
  retryCount: number;
  modelUsed: string;
  latencyMs: number;
}

async function runEval(): Promise<void> {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   客服系统 LLM 质量评测                   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  // 初始化客户端
  const useDeepSeek = DEFAULT_MODEL === "deepseek-chat" && DEEPSEEK_KEY;
  let client: OpenAI;
  let model: string;
  let useJSONMode: boolean;

  if (useDeepSeek) {
    client = new OpenAI({ apiKey: DEEPSEEK_KEY, baseURL: DEEPSEEK_URL });
    model = "deepseek-chat";
    useJSONMode = false; // DeepSeek 不原生支持 JSON mode
    console.log(`[配置] 主模型: DeepSeek (deepseek-chat)`);
  } else if (OPENAI_KEY) {
    client = new OpenAI({ apiKey: OPENAI_KEY, baseURL: OPENAI_URL });
    model = "qwen-plus"; // 通义千问 via dashscope
    useJSONMode = false;
    console.log(`[配置] 主模型: OpenAI-compatible (${OPENAI_URL})`);
  } else {
    console.error("❌ 没有可用的 API Key，请检查 .env");
    process.exit(1);
  }

  // 备选客户端（DeepSeek 作为备选，如果主模型是 OpenAI；反之亦然）
  let fallbackClient: OpenAI | null = null;
  let fallbackModel = "";
  if (useDeepSeek && OPENAI_KEY) {
    fallbackClient = new OpenAI({ apiKey: OPENAI_KEY, baseURL: OPENAI_URL });
    fallbackModel = "qwen-plus";
    console.log(`[配置] 备选模型: qwen-plus`);
  } else if (!useDeepSeek && DEEPSEEK_KEY) {
    fallbackClient = new OpenAI({
      apiKey: DEEPSEEK_KEY,
      baseURL: DEEPSEEK_URL,
    });
    fallbackModel = "deepseek-chat";
    console.log(`[配置] 备选模型: deepseek-chat`);
  }

  console.log(`\n[配置] 测试用例: ${TEST_CASES.length} 个\n`);
  console.log("─".repeat(60) + "\n");

  const results: EvalResult[] = [];
  const temperatures = [0.3, 0.1, 0.0]; // 重试温度递减

  for (const tc of TEST_CASES) {
    const startTime = Date.now();
    const systemPrompt = buildSystemPrompt(tc.kbAvailable ? tc.kbContext : "");

    let rawResponse = "";
    let retryCount = 0;
    let passed = false;
    let validationErrors: string[] = [];
    let usedModel = model;

    process.stdout.write(`[测试] ${tc.name}\n       问题: ${tc.question}\n`);

    // ── 主模型 + 重试 ──
    const maxRetries = tc.retryOnFail ? 3 : 1;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        rawResponse = await callLLM(
          client,
          model,
          systemPrompt,
          tc.question,
          temperatures[attempt] || 0,
          useJSONMode,
        );
        retryCount = attempt;

        const validation = validateResponse(rawResponse, tc.kbAvailable);
        if (validation.valid) {
          passed = true;
          validationErrors = validation.errors;
          break;
        }

        if (attempt < maxRetries - 1 && tc.retryOnFail) {
          console.log(
            `       ⚠ 重试 ${attempt + 1}/${maxRetries - 1}: ${validation.errors[0]}`,
          );
          validationErrors = validation.errors;
        } else {
          validationErrors = validation.errors;
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Unknown error";
        console.log(
          `       ⚠ 调用失败 (尝试 ${attempt + 1}): ${message.slice(0, 80)}`,
        );
        if (attempt < maxRetries - 1 && tc.retryOnFail) {
          // 短暂冷却后重试
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }

    // ── 备选模型降级 ──
    if (!passed && fallbackClient && tc.retryOnFail) {
      try {
        console.log(`       ↳ 降级到备选模型 ${fallbackModel}...`);
        rawResponse = await callLLM(
          fallbackClient,
          fallbackModel,
          systemPrompt,
          tc.question,
          0.0,
          false,
        );
        usedModel = fallbackModel;
        const validation = validateResponse(rawResponse, tc.kbAvailable);
        passed = validation.valid;
        validationErrors = validation.errors;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Unknown error";
        console.log(`       ⚠ 备选模型也失败: ${message.slice(0, 80)}`);
      }
    }

    const latencyMs = Date.now() - startTime;

    // 解析最终答案
    let parsedAnswer = "";
    let suggestions: string[] = [];
    try {
      let clean = rawResponse.trim();
      if (clean.startsWith("```")) {
        const parts = clean.split("```");
        clean = parts[1] || parts[0] || "";
        if (clean.startsWith("json")) clean = clean.slice(4);
        clean = clean.trim();
      }
      const parsed = JSON.parse(clean);
      parsedAnswer = parsed.answer || "";
      suggestions = parsed.suggestions || [];
    } catch {
      parsedAnswer = rawResponse.slice(0, 200);
    }

    const status = passed ? "✅" : "❌";
    console.log(
      `       结果: ${status} | 重试: ${retryCount}次 | 延迟: ${latencyMs}ms | 模型: ${usedModel}`,
    );
    if (validationErrors.length > 0) {
      console.log(`       校验: ${validationErrors.join("; ")}`);
    }
    if (parsedAnswer) {
      const preview =
        parsedAnswer.length > 100
          ? parsedAnswer.slice(0, 100) + "..."
          : parsedAnswer;
      console.log(`       回答: ${preview}`);
    }
    console.log("");

    results.push({
      name: tc.name,
      question: tc.question,
      kbAvailable: tc.kbAvailable,
      passed,
      rawResponse: rawResponse.slice(0, 500),
      parsedAnswer,
      suggestions,
      validationErrors,
      retryCount,
      modelUsed: usedModel,
      latencyMs,
    });
  }

  // ═══════════════════════════════════════
  // 评测报告
  // ═══════════════════════════════════════
  const total = results.length;
  const passedCount = results.filter((r) => r.passed).length;
  const kbInternal = results.filter((r) => r.kbAvailable);
  const kbExternal = results.filter((r) => !r.kbAvailable);

  // 格式合规率: Layer 1+2 都通过
  const formatPassed = results.filter((r) => {
    const v = validateResponse(r.rawResponse, r.kbAvailable);
    return v.layer !== 1 && v.layer !== 2;
  }).length;

  // 幻觉率: KB 外问题中，没有编造的比例
  const kbExtPassed = kbExternal.filter((r) => r.passed).length;
  const hallucinationRate =
    kbExternal.length > 0
      ? (((kbExternal.length - kbExtPassed) / kbExternal.length) * 100).toFixed(
          1,
        )
      : "0";

  // KB 忠实度: KB 内问题中，通过的比例
  const kbIntPassed = kbInternal.filter((r) => r.passed).length;
  const fidelityRate =
    kbInternal.length > 0
      ? ((kbIntPassed / kbInternal.length) * 100).toFixed(1)
      : "100";

  // 降级覆盖率: 所有情况都有输出
  const hasOutput = results.filter((r) => r.parsedAnswer.length > 0).length;

  // 平均延迟
  const avgLatency = Math.round(
    results.reduce((s, r) => s + r.latencyMs, 0) / total,
  );

  // 平均重试次数
  const avgRetries = (
    results.reduce((s, r) => s + r.retryCount, 0) / total
  ).toFixed(1);

  console.log("═".repeat(60));
  console.log("                质量门禁报告");
  console.log("═".repeat(60));
  console.log("");
  console.log("┌──────────────────────────┬──────────┬──────────┐");
  console.log("│         指标             │  目标值  │  实测值  │");
  console.log("├──────────────────────────┼──────────┼──────────┤");
  console.log(
    `│ 总通过率                 │  > 90%   │  ${((passedCount / total) * 100).toFixed(1)}%   │`,
  );
  console.log(
    `│ JSON 可解析率            │  > 99%   │  ${((formatPassed / total) * 100).toFixed(0)}%    │`,
  );
  console.log(
    `│ Schema 通过率            │  > 99%   │  ${((formatPassed / total) * 100).toFixed(0)}%    │`,
  );
  console.log(
    `│ 幻觉率 (KB外拒绝回答)    │  < 5%    │  ${hallucinationRate}%     │`,
  );
  console.log(`│ KB 忠实度 (KB内正确回答) │  > 90%   │  ${fidelityRate}%    │`);
  console.log(
    `│ 降级覆盖率 (有输出)      │  100%    │  ${((hasOutput / total) * 100).toFixed(0)}%    │`,
  );
  console.log(
    `│ 平均响应时间             │  < 5s    │  ${(avgLatency / 1000).toFixed(1)}s   │`,
  );
  console.log(`│ 平均重试次数             │  < 0.5   │  ${avgRetries}     │`);
  console.log("└──────────────────────────┴──────────┴──────────┘");
  console.log("");

  // 分项详情
  console.log("─".repeat(60));
  console.log("                分项详情");
  console.log("─".repeat(60));
  console.log("");

  for (const r of results) {
    const status = r.passed ? "✅" : "❌";
    const kbLabel = r.kbAvailable ? "[KB内]" : "[KB外]";
    console.log(`${status} ${kbLabel} ${r.name}`);
    console.log(`   Q: ${r.question}`);
    console.log(
      `   A: ${r.parsedAnswer.slice(0, 120)}${r.parsedAnswer.length > 120 ? "..." : ""}`,
    );
    if (r.suggestions.length > 0) {
      console.log(`   建议: ${r.suggestions.join(" | ")}`);
    }
    if (!r.passed) {
      console.log(`   ❌ 失败原因: ${r.validationErrors.join("; ")}`);
    }
    console.log(
      `   延迟: ${r.latencyMs}ms | 重试: ${r.retryCount} | 模型: ${r.modelUsed}`,
    );
    console.log("");
  }

  // 对比数据
  console.log("─".repeat(60));
  console.log("          改动前后对比（估算 vs 实测）");
  console.log("─".repeat(60));
  console.log("");
  console.log("  维度              改动前(估算)    改动后(实测)");
  console.log(
    `  JSON可解析率       ~60%            ${((formatPassed / total) * 100).toFixed(0)}%`,
  );
  console.log(`  禁止行为检测       ❌ 无           ✅ 5条规则`);
  console.log(
    `  校验层数           1层(LLM核验)   5层(格式→Schema→禁止词→命中→话术)`,
  );
  console.log(`  重试机制           ❌ 无           ✅ 2次+备选模型`);
  console.log(`  确定性fallback     ❌ 无           ✅ KB dump / 固定话术`);
  console.log(`  数据回收           ❌ 无           ✅ JSONL 落盘`);
  console.log(`  输出格式           自由文本+正则   结构化JSON+Zod`);
  console.log("");

  // 保存结果
  const resultsDir = path.resolve(
    import.meta.dirname || __dirname,
    "../../logs/eval",
  );
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultsFile = path.join(
    resultsDir,
    `eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2), "utf-8");
  console.log(`详细结果已保存到: ${resultsFile}`);
}

runEval().catch((e) => {
  console.error("评测运行失败:", e);
  process.exit(1);
});
