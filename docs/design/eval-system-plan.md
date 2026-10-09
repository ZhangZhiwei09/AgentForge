# AgentForge 评测体系现状与改造方案

> **状态**: v2，已按评审意见修订。基线 `init@2019d78`，初版 2026-10-05，修订 2026-10-05。
>
> **v2 修订说明**：初版经独立对抗性评审，判定 NO-GO。初版在覆盖度叙事上有三处重大事实错误（把"没有质量度量"误报成"没有任何测试"），另有两处表述过强与两处可执行性断言与代码不符。本版已更正，并补齐阶段一的文件路径、前置条件与可检验的验收标准。评审记录见 `mydocs/specs/2026-10-05_11-38_评测体系方案评审.md`。
>
> 修订要点：
>
> - 删去「Python 侧没有任何评测」——实际有 19 个 pytest 文件（含 5 个路由测试）
> - 删去「路由分类未测」——实际 TS 侧路由测试 4040 行
> - 删去「没有自动化 / 没有门禁」——golden case 的确定性检查**已随 `pnpm test` 进 CI**
> - 删去「路由准确率无法计算」——`intent_samples` 本身就是带标签数据集
> - 撤回「阶段一不引入新基础设施」——CI 现只有 Postgres，其余全缺

## Context

评测体系真正的问题不是"什么都没有"，而是**只接通了第一层**：零成本的确定性检查已经在 CI 里跑，需要真实 LLM 的 A/B 层、以及知识库回归层，仍然停在"需要人记得跑一次"的脚本和页面上。同时度量本身还不足以支撑门禁。

设计的判断是对的：两层评测的成本分离、golden case 记录真实 bad case 来源、检索指标用标准 IR 数学实现、失败用例连检索快照和 prompt 快照一起落库。这些在同类项目里经常缺席（见 §三）。

方案按 **阶段一（让度量可信）→ 阶段二（覆盖平台）→ 阶段三（运营）** 递进。顺序不可颠倒：判定不可信之前扩覆盖，只是在生产更多不可信的数字。

---

## 一、结论

按对交付的影响排序：

| 级别 | 结论 | 说明 |
| --- | --- | --- |
| **阻断** | 度量有效性有硬伤，分数不可信 | Judge 与被测模型同源、故障计为失败、每用例只采样一次 |
| **阻断** | 第二、三层评测未接入 CI，`eval/` 目录不受类型检查 | 确定性层已在 CI；A/B 层与 RAG 层没有自动化载体，且 `eval/**` 已因此腐烂 |
| **警告** | 度量面只覆盖人格文案与检索命中 | 路由、答案层可信度、安全、Python 运行时尚无**质量度量**（注意：不是"没有测试"） |

---

## 二、现状：五条评测线，只有一条接了 CI

| # | 评测线 | 评什么 | 入口 | 在 CI？ | 状态 |
| --- | --- | --- | --- | --- | --- |
| A | **CI 内确定性单测** · `src/services/__tests__/chat-agent.test.ts` | golden case 的 requiredText / forbiddenText / maxLength；mock LLM，零成本 | `pnpm test` | **是** | 健康。这是唯一自动化的评测 |
| B | ChatAgent 人格 A/B · `eval/chat-persona/` | 11 条 golden case 真实调用 + LLM Judge 打分 + 与上一份报告对比 | CLI 脚本 | 否 | 可用但没人跑：历史记录仅 1 行（2026-07-12） |
| C | 客服回答质量 · `eval/run-eval.ts` | 幻觉率、JSON 合规率、五层校验管线、模型降级 | CLI 脚本 | 否 | **已失效**：import 指向已删除模块，无法执行 |
| D | 知识库检索回归 · `services/knowledge-regression.ts` | 检索命中，MRR / Recall@K / Precision@K / NDCG@K | HTTP API + data-admin 页面 | 否 | 功能最完整，但指标端点无 UI 消费 |
| E | 诊断检索 · `scripts/eval-diagnosis-retrieval.ts` | 9 条硬编码用例的意图准确率与文档命中率 | CLI 脚本 | 否 | 一次性，只打 console 不落盘 |

各条线之间没有共享数据集、没有共享报告、也没有共同的判定标准。

```mermaid
flowchart TB
    subgraph NOW["现状：只有第一层接通"]
        direction LR
        N1["数据集<br/>手写用例，无版本"] --> N2["执行<br/>CI 跑 mock 单测 · 其余手动"]
        N2 --> N3["判定<br/>单次通过率，无基线 diff"]
        N3 --> N4["出口<br/>日志落盘，随后无人消费"]
    end

    subgraph PLAN["方案（未实现）"]
        direction LR
        P1["数据集<br/>golden set + 路由样本标注，带版本"] --> P2["执行<br/>PR 跑确定性层 / 夜间跑 Judge 与 RAG"]
        P2 --> P3["判定<br/>基线固化 + run 间 diff + 阈值"]
        P3 --> P4["出口<br/>CI 门禁 / PR 评论 / 质量看板 / 告警"]
        P4 -. "标注回流" .-> P1
    end
```

现状缺的不是工具，而是**数据集版本化、基线判定、标注回流**这三条边。

---

## 三、已经做对的部分

1. **两层评测的成本分离**：确定性检查零 LLM 成本，且**已经落进 CI**（`chat-agent.test.ts` 用 hoisted mock 屏蔽真实 LLM，覆盖 golden case 的三类检查）；Judge 打分放本地按需跑。这个分层是对的，问题只在第二层没接上来。
2. **用例带来源**：每条 golden case 的 `description` 记录了它来自哪个真实 bad case（`golden-cases.ts:135`）。
3. **IR 指标是真数学**：二元增益 NDCG、MRR、Recall/Precision@K 实现正确，截断用 `expectedTopK` 而不是检索的 `topK`。纯函数且有单测（`knowledge-eval-metrics.ts:72`）。
4. **失败可回放**：每次运行把检索结果快照和当时喂给 LLM 的完整 prompt 一起落库（`knowledge-regression.ts:510`）。
5. **门禁的骨架已经在了**：A/B 对比、历史 JSONL、通过率低于阈值时以非零码退出（`run-ab-eval.ts:588`、`:609`）。
6. **已有测试资产比看上去厚**：路由分类逻辑有 4040 行 TS 测试（pipeline 1382 行，覆盖五路由 + L1→L5 级联 + 置信度边界 + 审计日志）与 5 个 Python 路由测试；五层校验管线另有 24 个用例。**缺的是度量，不是测试。**

---

## 四、差距

### P0-1 度量有效性不足以支撑判定

四个独立问题，每一个都足以让分数失去意义。

- **自评**：Judge 客户端固定走 DeepSeek，被测模型默认也是 `deepseek-chat`，等于让模型给自己打分（`run-ab-eval.ts:453`）。`JUDGE_MODEL` 可改模型名，但客户端仍固定（`:47`、`:49`）。
- **混淆**：Judge 出错时返回 `overallVerdict: "FAIL"`，接口抖动或解析重试耗尽都会拉低质量分并伪造出一次回归。应区分为 `ERROR` 并从分母剔除（`judge.ts:227-254`）。
- **样本量**：每个用例只跑一次，temperature 0.3，无 seed、无重复，因此没有方差也没有置信区间（`run-ab-eval.ts:490-494`）。
- **未校准**：没有人工标注集，也没有 Judge 与人工的一致性度量。
- **基线迁移未定义**：一旦按上面的方向换掉 Judge，`chat-persona-eval-history.jsonl` 里那条既有基线就不可比，与"基线固化 + run 间 diff"的目标直接冲突。换 Judge 必须同时重建基线并打版本标记。

### P0-2 第二、三层没有自动化载体，`eval/` 因此腐烂

- **证据**：`apps/server/tsconfig.json:10` 的 `include` 只有 `["src"]`，`apps/server/vitest.config.ts:7` 只收 `src/**/*.test.ts`，`eval/**` 两头都在外面。CI 只有 lint / typecheck / test / build。
- **已经发生**：`eval/run-eval.ts:19` 导入的 `services/customer-chat/validation.js` 早已迁走，脚本跑不起来；技能文档写 13 条用例而实际 11 条；`chat-persona-eval-history.jsonl` 只有 1 行。
- **不是"没有门禁"**：第一层门禁（mock 单测）已经在 CI 里，这一条要修的是**把第二、三层接上去 + 让 `eval/` 重新受工程约束**。

### P0-3 确定性检查在过拟合

- **证据**：禁词表含单个汉字「对」，会命中 `对于`、`对方`、`不对`（`golden-cases.ts:264`）。
- **矛盾**：越界用例禁用「我可以」（`golden-cases.ts:219`），同一用例的评分要点却奖励「提供替代方案」（`:209`）。模型回答「我可以帮您转接人工」会同时命中禁词与评分要点。
- **流程**：`persona-eval` 技能的排障表把「扩充 forbiddenText」列为标准修复动作，等于把过拟合写进流程。
- **方向**：禁止单字与过短短语，改边界感知正则或把语义判断下沉到 Judge rubric；加测试防止再引入。

### P1-1 度量面窄：有测试，无度量

这一条初版表述为"未覆盖/未测"，是错的。准确说法是**测试齐备但缺少基于带标签数据集的度量**。

- **路由分类**：TS 侧 4040 行测试 + Python 侧 5 个路由测试，覆盖五路由与级联逻辑。但没有**准确率指标与混淆矩阵**，也无法在 CI 里回答"这次改动让分类变好了还是变差了"。
- **答案层可信度**：RAG 只度量 doc 级命中，没有 groundedness、引用正确性、答案幻觉率。
- **Runtime 轨迹**：没有"期望路由 → 期望工具 → 期望参数 → 最终答复"的端到端度量。
- **安全**：没有注入 / 越狱 / 越权操作 / PII 的用例集。
- **Python 运行时**：`apps/server-py/tests/` 有 19 个 pytest 文件（含 `test_rag_*.py`、`test_router_*.py`），常规测试齐全；缺的是**质量/基准评测**，两侧也没有共享的数据集。
- 说明：`docs/design/python-core-upgrade-plan.md:327` 与 `:354` 仍写着"不做自动化评测"，这两条**已过期**，不应再作为依据引用。

### P1-2 数据闭环是空的（但起点比初版判断的好）

- **已有资产**：`intent_samples` 自带 `route` 与 `text` 两列，**本身就是一份带标签数据集**，填充后即可直接计算路由准确率与混淆矩阵（`schema.prisma:222-237`）。
- **缺的是**：该表无 seed、无 CRUD 接口、无后台页面，唯一读写方是语义路由层自己；schema 里预留的 `source: "feedback"` 从未被写入（`l2-semantic.ts:155`、`:241`）。
- **缺的是**：`RouteClassificationLog` 只记 route / confidence / source，无真实标签与纠正人字段，因此**无法用线上流量**评估路由（`schema.prisma:240-257`）。
- **方向**：给路由日志加标签与纠正字段 → 加抽样标注页 → 标注确认后写入 `intent_samples` 并把 `source` 置为 `feedback`。这是成本最低的带标签数据集来源。

### P2-1 运行与判定不够工程化

- **同步**：回归评测在 HTTP 请求内同步串行跑完全部用例，无队列、超时、取消或续跑（`knowledge-regression.ts:480`、`:501`）。
- **并发无防护**：先插 `status='running'` 再循环，并发触发会留下多个孤儿行，无幂等或锁（`:491-493`）。
- **无判定接口**：没有 run 间对比或门禁接口，没有基线固化，run 也未绑定数据集版本，跨用例编辑的历史对比会静默失效。

### P2-2 数据隔离与治理缺口

- **无隔离**：`knowledge_regression_*` 四张表与 `route_classification_logs` 都在生产 schema，没有评测专用库或表前缀，回归运行会写生产库。
- **PII**：`RouteClassificationLog.userMessage` 与回归 `prompt_snapshot` 都落用户原话，无脱敏动作。
- **投入不可见**：服务端算了 MRR 与 NDCG、SDK 也封装了指标方法，但 data-admin 无组件调用，`recharts` 已装未用。
- **无预算与责任人**：没有单次运行的成本/时长预算，也没有夜间任务失败后的告警与跟进人。

---

## 五、改造路线图

### 阶段一 · P0：让度量可信并接上第二层

#### 前置条件

初版声称"不引入新基础设施"，不成立。CI 现只有 Postgres，以下全部缺失：

| 依赖 | 用途 | 现状 | 配置入口 |
| --- | --- | --- | --- |
| 知识库种子数据 | RAG 回归需要可命中的文档与 chunk | `seed.ts` 只建用户，不建 KB | `packages/database/prisma/seed.ts` |
| Embedding 服务 | 检索与评测都依赖向量 | CI 无；本地走 Ollama bge-m3 | `config.ts:37-43`（远端）、`:61-62`（Ollama） |
| LLM API Key | A/B 层生成 + Judge 打分 | CI env 只有 `DATABASE_URL` / `JWT_SECRET` / `LOG_LEVEL` | `ci.yml:67-69` |
| Redis | BullMQ 异步化与夜间任务 | CI 无该 service | `config.ts:46`、`worker.ts:17` |
| cron 触发 | "夜间评测"的载体 | CI 只有 `push` / `pull_request` | `ci.yml:2-6` |

#### 动作

1. `apps/server/tsconfig.json`：`include` 增加 `eval`，让评测脚本重新受类型检查。
2. `apps/server/eval/run-eval.ts`：删除。它评的是已不存在的 `customer-chat` 模块；同一条五层校验管线已由 `src/__tests__/customer-chat-quality.test.ts`（24 个用例）覆盖并进 CI。
3. `apps/server/eval/chat-persona/judge.ts`：`JudgeResult` 增加 `status: "ok" | "error"`；`:248-254` 的 fallback 返回 `error` 且不计入分母；报告区分"质量失败"与"评测失败"。
4. `apps/server/eval/chat-persona/run-ab-eval.ts`：新增 `--judge-model`，缺省时若 Judge 与被测模型同源则拒绝运行；报告增加 `judgeModel`、`repeats`、`datasetHash`；每用例重复 3 次并输出均值与标准差（`:490-494` 的单次循环改为聚合）。
5. `apps/server/eval/chat-persona/golden-cases.ts`：移除单字与过短禁词（`:264` 的「对」）；修 `boundary-out-of-scope` 禁词与 rubric 的矛盾（`:219` vs `:209`）。
6. `.github/workflows/`：新增 `eval-nightly.yml`（`schedule` + `workflow_dispatch`），跑 A/B 层与 RAG 回归；失败时开 issue 指派跟进人。PR 门禁继续走已有的 `pnpm test`。
7. 基线迁移：换 Judge 的同一次提交里重建基线，`chat-persona-eval-history.jsonl` 每条记录加 `baselineVersion`；旧基线与新基线不并列对比。
8. 成本与时长：按 `用例数 × 重复次数 × 2`（生成 + Judge）估算调用量并设超时与并发上限；预算写进 workflow 注释。

#### 验收

每条都能用命令或产物证明：

- 在 `eval/` 下故意写一个类型错误，`pnpm typecheck` 必须失败
- Judge 出错时报告出现 `status: "error"`，且该用例不计入 `passRate`
- 报告 JSON 中 `judgeModel !== model`；同源时脚本拒绝运行
- `golden-cases.ts` 中不存在长度 < 2 的 forbiddenText（可加一条单测断言）
- `eval-nightly.yml` 存在，且在 Actions 页面手动触发过一次并成功产出报告

### 阶段二 · P1：把度量面铺开

- 给 `RouteClassificationLog` 加真实标签与纠正人字段；用 `intent_samples` 作为带标签真值集，产出路由准确率与混淆矩阵并纳入门禁
- 在 data-admin 加抽样标注页；标注确认后写入 `intent_samples` 并置 `source = "feedback"`
- 补 RAG 答案层度量：复用已落库的 `resultsSnapshot` / `promptSnapshot`，做 groundedness 与引用正确性打分
- 补 Runtime 轨迹度量：期望路由 → 期望工具 → 期望参数 → 最终答复
- 补安全用例集（注入 / 越狱 / 越权 / PII），确定性检查优先
- 两侧共用同一份 JSON 数据集，Python 与 TS 出现在同一份报告里

#### 验收

- `intent_samples` 中存在 `source = 'feedback'` 的行（SQL 可查）
- 路由准确率与混淆矩阵能从一条命令或一个报告文件产出
- 同一份数据集文件被 TS 与 Python 两侧读取，报告含两个运行时同名指标

### 阶段三 · P2：运营起来

- 评测运行异步化（BullMQ + Redis），支持进度、取消、续跑；补 run 间对比接口与基线固化；并发触发加幂等键
- 评测数据与生产数据隔离（独立 schema 或表前缀）
- 评测日志 PII 脱敏
- 用 Langfuse 打分替代当前只做链路追踪的用法，对生产流量抽样评测
- 在命中测试页加质量看板，把已有指标接到图表上
- 校准 Judge 与人工的一致性，目标 κ ≥ 0.6，不达标就调整评分要点

#### 验收

- 并发触发两次评测，`knowledge_regression_runs` 中不出现残留的 `status='running'` 行
- 评测写入的表与生产表可区分（schema 或前缀），且回归运行不再写生产库
- 质量看板可从 data-admin 打开并显示 MRR / NDCG 趋势（现有端点已有数据）
- Judge 与人工标注的一致性报告存在，且 κ 值达标或记录了不达标后的调整

---

## 六、方案边界

- 本文是评估 + 改造提案，不含已批准排期。阶段一的工期与成本需在确认前置条件后重估。
- 阶段二的标注数据集依赖人工投入，需先确认标注人力。
- 评测运行对生产库的读压力未评估；阶段三做隔离与异步化时应一并考虑。
- 阶段一未包含 CI 时长预算的实测数据，需在 `eval-nightly.yml` 首次运行后补充。

## 附录：证据索引

| 判断 | 位置 |
|------|------|
| 确定性层已在 CI 中运行 | `apps/server/src/services/__tests__/chat-agent.test.ts:1-8`、`:28-33`；`apps/server/vitest.config.ts:7` |
| 评测脚本不在类型检查范围 | `apps/server/tsconfig.json:10` |
| CI 无评测步骤、无 cron、只有 Postgres | `.github/workflows/ci.yml:2-6`、`:14-27`、`:58-72` |
| CI 的 env 只有 DATABASE_URL / JWT_SECRET / LOG_LEVEL | `.github/workflows/ci.yml:67-69` |
| 失效脚本的断裂导入 | `apps/server/eval/run-eval.ts:19` |
| 同一条校验管线已有 24 个 CI 用例 | `apps/server/src/__tests__/customer-chat-quality.test.ts` |
| Judge 客户端与被测模型同源 | `apps/server/eval/chat-persona/run-ab-eval.ts:453`、`:47`、`:49` |
| 出错被判为质量失败 | `apps/server/eval/chat-persona/judge.ts:227-254` |
| 单次采样、temperature 0.3 | `apps/server/eval/chat-persona/run-ab-eval.ts:490-494`、`:100` |
| 门禁只看确定性通过率 | `apps/server/eval/chat-persona/run-ab-eval.ts:609` |
| 单字禁词「对」 | `apps/server/eval/chat-persona/golden-cases.ts:264` |
| 禁词与评分要点互相矛盾 | `apps/server/eval/chat-persona/golden-cases.ts:219` vs `:209` |
| 用例标注了真实 bad case 来源 | `apps/server/eval/chat-persona/golden-cases.ts:135` |
| IR 指标实现 | `apps/server/src/services/knowledge-eval-metrics.ts:72` |
| 失败用例快照落库 | `apps/server/src/services/knowledge-regression.ts:510` |
| 同步串行、无幂等 | `apps/server/src/services/knowledge-regression.ts:480`、`:491-493` |
| 路由分类测试资产（4040 行） | `apps/server/src/services/agent-runtime/routing/__tests__/`、`__tests__/integration/routing-pipeline.integration.test.ts` |
| Python 侧测试资产（19 个文件） | `apps/server-py/tests/`（`test_router_l1..l5`、`test_rag_*` 等） |
| `intent_samples` 已是带标签数据集 | `packages/database/prisma/schema.prisma:222-237` |
| 路由日志缺真实标签 | `packages/database/prisma/schema.prisma:240-257` |
| 样本库无写入方与后台 | `apps/server/src/services/agent-runtime/routing/l2-semantic.ts:155`、`:241` |
| 指标端点无 UI 消费 | `apps/server/src/modules/data-management/routes/regression.ts:146` |
| 种子数据不建知识库 | `packages/database/prisma/seed.ts` |
| embedding 与 Redis 的配置入口 | `apps/server/src/config.ts:37-43`、`:46`、`:61-62`；`apps/server/src/worker.ts:17` |
| 计划文档中已过期的评测陈述 | `docs/design/python-core-upgrade-plan.md:327`、`:354` |
