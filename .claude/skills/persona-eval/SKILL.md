---
name: persona-eval
description: 运行 ChatAgent Persona 评测回归，对比修改前后的质量变化
args: [--judge] [--compare]
---

# persona-eval

对 ChatAgent 的角色设定进行质量评测。每次修改 persona 后都应运行此技能，防止角色退化。

## 评测体系（两层）

```
Layer 1（CI, 30s, 零 LLM 成本）
  npx vitest chat-agent.test.ts
  → mock LLM，检查 requiredText / forbiddenText / maxLength

Layer 2（本地, 2-3min, 调真实 LLM）
  npx tsx apps/server/eval/chat-persona/run-ab-eval.ts --judge
  → 13 个 Golden Case 真实调用 + LLM-as-Judge 打分
```

## 工作流

### 1. 先跑 Layer 1（必须）

```bash
cd apps/server && npx vitest run src/services/__tests__/chat-agent.test.ts
```

- 12 个测试全部通过 → 继续 Layer 2
- 有失败 → 说明 mock 响应格式变了或 persona 丢了关键标记，先修再继续

### 2. 再跑 Layer 2（可选，但改 persona 内容后必须跑）

```bash
cd apps/server && npx tsx eval/chat-persona/run-ab-eval.ts --judge
```

- 输出每个 case 的 ✅/❌ + Judge 评分
- 结果保存到 `logs/eval/chat-persona-eval-*.json`

### 3. 对比旧结果（改 persona 后必须做）

先找到上一次的评测文件：

```bash
ls apps/server/logs/eval/chat-persona-eval-*.json | tail -2
```

然后用 `--compare` 对比：

```bash
cd apps/server && npx tsx eval/chat-persona/run-ab-eval.ts --judge --compare logs/eval/chat-persona-eval-<上一次>.json
```

对比报告会标注每个 case 是 ▲改进、▼回归、还是 —无变化。

## 结果解读

### 确定性检查（detPassed）

检查项来自 `golden-cases.ts` 中的 `requiredText`、`forbiddenText`、`maxLength`：

- ❌ `requiredText` 未命中 → persona 丢失了关键身份标记（如英文回复没说 "AgentForge"）
- ❌ `forbiddenText` 命中 → persona 引入了不该出现的内容（如通用 AI 口吻）
- ❌ `maxLength` 超限 → 回答变啰嗦了

### Judge 评分（judgeResult）

每个维度 1-5 分，`overallVerdict: FAIL` 时要关注 `issues` 列表：

- **2/5**：严重偏离角色设定，需要修改 persona 的 examples 或 constraints
- **3/5**：可接受但不够好，考虑微调 tone 或加 example
- **4/5**：良好，可以接受
- **5/5**：完美

### 门禁标准

| 指标 | 目标 |
|------|------|
| 确定性检查通过率 | > 90% |
| Judge 评分通过率 | > 80% |
| 对比无回归 | 不允许 ▼ 回归 |

## 常见问题定位

| 现象 | 根因 | 修复方向 |
|------|------|---------|
| 英文回复丟了 "AgentForge" | persona examples 缺少英文场景 | 在 examples 中加一条英文对话 |
| 乱码输入回复太生硬 | constraints 太严格，LLM 理解为"拒绝" | 把"不闲聊"改为"引导用户表达真实意图" |
| 能力范围 creep | constraints 中的禁止词不够具体 | 检查 `forbiddenText` 是否需要扩充 |
| Judge 反复给 3 分 | tone 描述不够具体 | 在 persona tone 中加具体的正反例 |

## 文件索引

| 文件 | 职责 |
|------|------|
| `packages/shared-prompts/src/persona.ts` | Persona 定义 + Prompt 构建器 |
| `apps/server/eval/chat-persona/golden-cases.ts` | 13 个 Golden Case 定义 |
| `apps/server/eval/chat-persona/judge.ts` | LLM-as-Judge 评分逻辑 |
| `apps/server/eval/chat-persona/run-ab-eval.ts` | A/B 评测脚本 |
| `apps/server/src/services/__tests__/chat-agent.test.ts` | 确定性单元测试 |
