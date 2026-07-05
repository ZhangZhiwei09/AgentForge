/**
 * 诊断 Agent 检索效果评测脚本
 *
 * 评测维度：
 * 1. 意图识别准确率
 * 2. 知识召回的相关性（命中标题是否匹配查询意图）
 * 3. 检索排序质量（最相关的文档是否排在最前面）
 *
 * 用法: pnpm --filter @agentforge/server exec tsx ../../scripts/eval-diagnosis-retrieval.ts
 */

// ── 测试用例定义 ──
interface TestCase {
  query: string;
  expectedIntent: string;
  expectedDocKeyword: string; // 预期顶部文档标题应包含的关键词
  acceptableDocs: string[];   // 可接受的相关文档关键词列表
}

const TEST_CASES: TestCase[] = [
  // ═══ 意图1: error_code_explanation ═══
  {
    query: "FACE_TIMEOUT 是什么原因，怎么处理？",
    expectedIntent: "error_code_explanation",
    expectedDocKeyword: "FACE_TIMEOUT",
    acceptableDocs: ["FACE_TIMEOUT", "网络超时", "NETWORK", "TIMEOUT"],
  },
  {
    query: "LIVENESS_FAIL 活体检测一直过不了",
    expectedIntent: "error_code_explanation",
    expectedDocKeyword: "LIVENESS_FAIL",
    acceptableDocs: ["LIVENESS_FAIL", "活体检测失败", "活体通过率"],
  },
  {
    query: "报错 NETWORK_TIMEOUT 怎么办",
    expectedIntent: "error_code_explanation",
    expectedDocKeyword: "NETWORK_TIMEOUT",
    acceptableDocs: ["NETWORK_TIMEOUT", "网络超时", "FACE_TIMEOUT"],
  },

  // ═══ 意图2: single_trace_diagnosis ═══
  {
    query: "traceId abc123 用户刷脸失败，帮忙看下",
    expectedIntent: "single_trace_diagnosis",
    expectedDocKeyword: "FACE_TIMEOUT",
    acceptableDocs: ["FACE_TIMEOUT", "批量失败", "LIVENESS", "NETWORK"],
  },
  {
    query: "orderId xyz789 人脸核身不通过，排查一下",
    expectedIntent: "single_trace_diagnosis",
    expectedDocKeyword: "FACE_TIMEOUT",
    acceptableDocs: ["FACE_TIMEOUT", "LIVENESS", "通过率"],
  },

  // ═══ 意图3: merchant_rate_drop ═══
  {
    query: "商户 10086 今天上午活体通过率下降，帮忙排查",
    expectedIntent: "merchant_rate_drop",
    expectedDocKeyword: "通过率",
    acceptableDocs: ["通过率优化", "通过率基线", "批量失败", "LIVENESS_FAIL"],
  },
  {
    query: "商户 20001 最近三天人脸识别成功率从95%掉到70%",
    expectedIntent: "merchant_rate_drop",
    expectedDocKeyword: "通过率",
    acceptableDocs: ["通过率优化", "通过率基线", "批量失败", "接入配置"],
  },

  // ═══ 意图4: integration_guidance / needs_clarification ═══
  {
    query: "H5 页面调用摄像头提示权限被拒绝",
    expectedIntent: "integration_guidance",
    expectedDocKeyword: "CAMERA_PERMISSION",
    acceptableDocs: ["CAMERA_PERMISSION_DENIED", "SDK 集成", "H5"],
  },
  {
    query: "核身失败了，帮忙看下",
    expectedIntent: "unknown",
    expectedDocKeyword: "",
    acceptableDocs: [],
  },
];

// ── 评测指标 ──
interface EvalResult {
  query: string;
  intentMatch: boolean;
  expectedIntent: string;
  actualIntent: string;
  topDocTitle: string;
  topDocRelevant: boolean;
  relevantCount: number;
  totalRetrieved: number;
  retrievedTitles: string[];
}

const BASE_URL = "http://localhost:8000";

async function runOne(query: string): Promise<any> {
  const res = await fetch(`${BASE_URL}/api/diagnosis/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return res.json();
}

function isRelevant(title: string, acceptableKeywords: string[]): boolean {
  if (acceptableKeywords.length === 0) return title === ""; // needs_clarification 不应有文档
  return acceptableKeywords.some(kw => title.includes(kw));
}

async function main() {
  console.log("=".repeat(72));
  console.log("诊断 Agent 检索效果评测报告");
  console.log("=".repeat(72));
  console.log();

  const results: EvalResult[] = [];

  for (let i = 0; i < TEST_CASES.length; i++) {
    const tc = TEST_CASES[i];
    console.log(`[${i + 1}/${TEST_CASES.length}] 查询: ${tc.query.slice(0, 50)}...`);
    const data = await runOne(tc.query);

    const knowledgeDocs = (data.evidence || [])
      .filter((e: any) => e.source === "knowledge");

    const topDoc = knowledgeDocs[0];
    const topTitle = topDoc?.title ?? "";
    const relevantDocs = knowledgeDocs.filter((d: any) =>
      isRelevant(d.title, tc.acceptableDocs)
    );

    const result: EvalResult = {
      query: tc.query,
      intentMatch: data.intent === tc.expectedIntent,
      expectedIntent: tc.expectedIntent,
      actualIntent: data.intent,
      topDocTitle: topTitle,
      topDocRelevant: tc.acceptableDocs.length > 0
        ? isRelevant(topTitle, tc.acceptableDocs)
        : true, // needs_clarification 场景无文档 → 通过
      relevantCount: relevantDocs.length,
      totalRetrieved: knowledgeDocs.length,
      retrievedTitles: knowledgeDocs.map((d: any) => d.title),
    };

    results.push(result);

    // 逐条输出
    const icon = result.intentMatch && result.topDocRelevant ? "✅" : "❌";
    console.log(`  ${icon} 意图: ${data.intent} → ${tc.expectedIntent} ${result.intentMatch ? "✓" : "✗"}`);
    if (tc.expectedDocKeyword) {
      console.log(`  ${icon} 顶部文档: ${topTitle.slice(0, 60)}`);
      console.log(`     相关文档: ${relevantDocs.length}/${knowledgeDocs.length} (预期关键词: ${tc.expectedDocKeyword})`);
    } else {
      console.log(`  ${icon} 无知识检索 (needs_clarification): ${knowledgeDocs.length === 0 ? "✓" : "✗ 意外检索到文档"}`);
    }

    // 展示召回列表
    if (knowledgeDocs.length > 0) {
      for (let j = 0; j < Math.min(knowledgeDocs.length, 5); j++) {
        const d = knowledgeDocs[j];
        const rel = isRelevant(d.title, tc.acceptableDocs) ? "✓" : "✗";
        console.log(`      #${j + 1} [${rel}] ${d.title.slice(0, 55)}`);
      }
    }
    console.log();
  }

  // ── 汇总统计 ──
  console.log("=".repeat(72));
  console.log("汇总统计");
  console.log("=".repeat(72));

  const intentAccuracy = results.filter(r => r.intentMatch).length / results.length;
  const topDocRelevance = results.filter(r => r.topDocRelevant).length / results.length;
  const avgRelevant = results.reduce((s, r) => s + r.relevantCount, 0) / results.length;
  const avgRetrieved = results.reduce((s, r) => s + r.totalRetrieved, 0) / results.length;

  console.log(`  测试用例数:        ${results.length}`);
  console.log(`  意图识别准确率:    ${(intentAccuracy * 100).toFixed(0)}% (${results.filter(r => r.intentMatch).length}/${results.length})`);
  console.log(`  顶部文档相关性:    ${(topDocRelevance * 100).toFixed(0)}% (${results.filter(r => r.topDocRelevant).length}/${results.length})`);
  console.log(`  平均相关文档数:    ${avgRelevant.toFixed(1)} / ${avgRetrieved.toFixed(1)} 篇`);
  console.log();

  // 分意图统计
  console.log("分意图统计:");
  console.log("-".repeat(72));
  const byIntent = new Map<string, EvalResult[]>();
  for (const r of results) {
    const key = r.expectedIntent;
    if (!byIntent.has(key)) byIntent.set(key, []);
    byIntent.get(key)!.push(r);
  }

  console.log("  intent                    | 准确率 | 顶部相关性 | 平均相关/总数");
  console.log("  --------------------------|--------|-----------|---------------");
  for (const [intent, items] of byIntent) {
    const acc = items.filter(r => r.intentMatch).length / items.length;
    const rel = items.filter(r => r.topDocRelevant).length / items.length;
    const avgRel = items.reduce((s, r) => s + r.relevantCount, 0) / items.length;
    const avgTotal = items.reduce((s, r) => s + r.totalRetrieved, 0) / items.length;
    console.log(
      `  ${intent.padEnd(26)} | ${(acc * 100).toFixed(0).padStart(5)}% | ${(rel * 100).toFixed(0).padStart(8)}% | ${avgRel.toFixed(1)}/${avgTotal.toFixed(1)}`,
    );
  }
  console.log();

  // 失败用例汇总
  const failures = results.filter(r => !r.intentMatch || !r.topDocRelevant);
  if (failures.length > 0) {
    console.log("需关注的用例:");
    for (const f of failures) {
      console.log(`  ❌ "${f.query.slice(0, 40)}..."`);
      if (!f.intentMatch) console.log(`     意图错误: 期望 ${f.expectedIntent}, 实际 ${f.actualIntent}`);
      if (!f.topDocRelevant) console.log(`     顶部文档不相关: ${f.topDocTitle}`);
    }
  } else {
    console.log("🎉 全部用例通过!");
  }
  console.log();
  console.log("=".repeat(72));
  console.log("评测时间:", new Date().toISOString());
  console.log("知识库ID: kb-identity-0001 (核身排障知识库, 11篇文档)");
  console.log("依赖服务: Ollama (embedding), PostgreSQL (PGVector), ES (不可用, PG keyword fallback)");
  console.log("=".repeat(72));
}

main().catch(e => {
  console.error("评测失败:", e.message);
  process.exit(1);
});
