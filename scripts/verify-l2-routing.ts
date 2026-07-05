/**
 * L2 语义分类器快速验证脚本
 * 用法: pnpm --filter @agentforge/server exec tsx ../../scripts/verify-l2-routing.ts
 */
import { SemanticClassifier } from "../apps/server/src/services/agent-runtime/semantic-classifier.js";
import { logger } from "@agentforge/logger";

async function main() {
  const classifier = new SemanticClassifier(5);

  const available = await classifier.isAvailable();
  logger.info({ available }, "L2 SemanticClassifier availability");

  if (!available) {
    logger.error("L2 not available — no embedding provider or no samples");
    process.exit(1);
  }

  const cases = [
    { msg: "一直转圈不往下走", expected: "DIAGNOSIS", desc: "隐式故障-转圈" },
    { msg: "怎么又弹回首页了", expected: "DIAGNOSIS", desc: "隐式故障-弹回" },
    { msg: "刷脸页面卡住了等了好久", expected: "DIAGNOSIS", desc: "隐式故障-卡住" },
    { msg: "刚才好好的现在怎么都过不去", expected: "DIAGNOSIS", desc: "隐式故障-过不去" },
    { msg: "你好", expected: "CHAT", desc: "问候" },
    { msg: "谢谢你的帮助", expected: "CHAT", desc: "感谢" },
    { msg: "活体认证需要多长时间", expected: "TASK", desc: "FAQ查询" },
    { msg: "怎么申请接入人脸核身服务", expected: "TASK", desc: "接入咨询" },
    { msg: "转人工客服", expected: "HUMAN", desc: "转人工" },
    { msg: "我要投诉你们的服务", expected: "HUMAN", desc: "投诉" },
  ];

  let passed = 0;
  let failed = 0;

  for (const { msg, expected, desc } of cases) {
    const result = await classifier.classify(msg);
    if (!result) {
      logger.warn({ msg, desc }, "L2 returned null (degrade to LLM)");
      failed++;
      continue;
    }

    const ok = result.route === expected;
    const status = ok ? "PASS" : "FAIL";
    console.log(
      `[${status}] "${msg}" → ${result.route} (conf=${result.confidence.toFixed(2)}, topSim=${result.matches[0]?.similarity?.toFixed(2)}) | ${desc}`,
    );

    if (ok) passed++;
    else failed++;
  }

  const accuracy = ((passed / cases.length) * 100).toFixed(1);
  console.log(`\n=== Results: ${passed}/${cases.length} passed (${accuracy}%), ${failed} failed ===`);

  // 关键指标：隐式故障表达是否能命中 DIAGNOSIS
  const implicitFaultCases = cases.filter((c) => c.expected === "DIAGNOSIS");
  const implicitHits = implicitFaultCases.filter(async (c) => {
    const r = await classifier.classify(c.msg);
    return r?.route === "DIAGNOSIS";
  }).length;
  // Actually let's recompute properly
  let implicitCorrect = 0;
  for (const c of implicitFaultCases) {
    const r = await classifier.classify(c.msg);
    if (r?.route === "DIAGNOSIS") implicitCorrect++;
  }
  const recall = ((implicitCorrect / implicitFaultCases.length) * 100).toFixed(1);
  console.log(`DIAGNOSIS Recall (隐式故障): ${implicitCorrect}/${implicitFaultCases.length} (${recall}%)`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(err, "Verification failed");
    process.exit(1);
  });
