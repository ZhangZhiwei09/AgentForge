# 智能客服 LLM 质量体系文档

> 评测日期：2026-06-10 | 模型：DeepSeek deepseek-chat | 用例数：10 | 通过率：100%

## 项目：智能客服 —— 基于知识库的匿名客户服务，给电商平台提供 7×24 自动化客服

---

## 一、核心架构决策

1. **LLM 的职责边界**
   - LLM 只负责：**将【已标记来源的知识库上下文】翻译为自然语言回答 + 生成追问建议**
   - LLM 绝不负责：**搜索知识库（Milvus 检索由代码完成）、编造政策/价格/流程、判断信息真伪**
   - 原因：LLM 的幻觉率在零上下文时接近 100%，但给定不可修改的权威上下文后可以做到忠实转述

2. **确定性上下文协议**
   - 在调用 LLM 之前，系统先把 **Milvus 向量搜索结果** 编译成带来源标记的结构化上下文
   - 每条数据的来源：**`fetchKnowledge()` → Milvus dense+sparse 混合搜索 → PG 查文档标题**
   - 来源标记格式：`[来源: "{docTitle}" | 不可修改 | 编号: KB-{i}]`
   - 实测效果：DeepSeek 在标记 "不可修改" 的 KB 上下文中，6 个 KB 内问题 100% 正确引用

3. **LLM 输出的格式约束**
   - 输出格式：**纯 JSON `{"answer": "...", "suggestions": [...]}`**
   - 为什么不能是自由文本：自由文本无法做 Schema 校验 → 无法自动检测编造 → 无法触发重试。结构化 JSON 让 5 层校验管线每一层都有明确的检查对象

4. **价格/数值的来源策略**
   - 当前场景无实时价格 API，数值完全来自人工维护的知识库文档
   - 第1优先级：知识库文档中的精确数值（如 "3-7 个工作日"）
   - 第2优先级：固定话术 SORRY_TEMPLATE（KB 无数据时）
   - 核心原则：**LLM 只能复制 KB 中的数值，不能修改，不能推算，不能补充**

5. **失败处理策略**
   - 第1层重试：同模型 temperature 递减（0.3 → 0.1 → 0.0），打散随机性
   - 第2层降级：切到备选模型（DeepSeek → qwen-plus / 反之），1 次
   - 第3层兜底：有 KB → dump chunk 原文 + "请联系人工客服"；无 KB → SORRY_TEMPLATE
   - 不重试的错误：API key 无效 (401)、内容风控 (400 content_filter)、速率限制 (429) 冷却后重试

6. **在线数据回收**
   - 所有调用样本自动落盘（成功 + 失败）：`logs/eval/cs-eval-{date}.jsonl`
   - 格式：JSONL，每行含 `{timestamp, sessionId, userMessage, rawResponse, finalOutput, validationErrors, retryCount, modelUsed, fallbackUsed}`
   - 后续用途：统计幻觉率趋势 → 优化禁止行为规则 → 积累 SFT 数据

---

## 二、数据模型（Schema）

```json
{
  "请求体": {
    "session_id": { "类型": "string|null", "来源": "浏览器 localStorage", "约束": "UUID v4" },
    "message": { "类型": "string", "来源": "用户输入", "约束": "1-2000 字符" }
  },
  "上下文协议（编译后送入 LLM）": {
    "kb_chunks": { "类型": "Array<{content, sourceTag}>", "来源": "Milvus + PG", "标注": "不可修改" },
    "source_tag": { "类型": "string", "来源": "fetchKnowledge() 生成", "格式": "[来源: {docTitle} | 不可修改 | 编号: KB-{i}]" },
    "memories": { "类型": "Array<{content}>", "来源": "MemoryEngine.search(sessionId)", "标注": "参考信息" },
    "hours_note": { "类型": "string|null", "来源": "规则引擎 isWithinServiceHours()", "标注": "不可修改" }
  },
  "响应体（LLM 输出）": {
    "answer": { "类型": "string", "约束": "1-2000 字符，KB 外必须 = SORRY_TEMPLATE" },
    "suggestions": { "类型": "string[]", "约束": "最多 3 个，每个 ≤ 50 字符" }
  }
}
```

---

## 三、LLM Prompt 硬约束

### 3.1 格式硬约束

- [x] 第一个非空字符必须是 `{`，最后一个必须是 `}`
- [x] 不得输出 Markdown、代码块标记、解释、前言、后记
- [x] 不得输出 `<think>` 或 `<thinking>` 标签

### 3.2 数据来源硬约束

- [x] `answer` 字段只能从上下文的【知识库参考资料】中引用，不得编造
- [x] 数值（天数、金额、比例）必须原样复制 KB 中的数据，不得修改
- [x] `answer` 在 KB 无匹配时，必须写固定话术 `SORRY_TEMPLATE`，不得编造

### 3.3 禁止行为清单

- [x] 禁止输出 "根据公司规定""经查询""据我了解" 等虚假权威表述
- [x] 禁止输出 "可能是由于""应该是" 等推测性表述（无 KB 依据时）
- [x] 禁止输出 "您的订单可能..." 等对客户信息的推测
- [x] 禁止输出 "建议您自行..." 等推卸责任式建议
- [x] 禁止在 KB 未提供的情况下输出任何具体数字

### 3.4 固定话术

```typescript
const SORRY_TEMPLATE = "抱歉，我目前没有找到相关信息，建议您联系人工客服获取帮助。";
const FALLBACK_PREFIX = "以下是可能相关的知识库内容，如需更多帮助请联系人工客服：\n\n";
```

---

## 四、输出校验管线

| Layer | 检查内容 | 不通过行为 | 实测命中 |
|-------|---------|-----------|---------|
| **L1** | `JSON.parse()` 可解析 | 重试 | 0 次失败 |
| **L2** | Zod Schema: `{answer: string(1-2000), suggestions: string[](≤3, ≤50)}` | 重试 | 0 次失败 |
| **L3** | 禁止行为扫描：5 条正则规则（虚假权威/推测原因/推测客户信息/推卸责任/虚假查询） | 重试 | 0 次命中 |
| **L4** | KB 关键词命中率 ≥ 50% | 软告警（记录日志不阻止） | 未触发 |
| **L5** | KB 为空 → answer 必须 = `SORRY_TEMPLATE` | 硬错误，重试 | 0 次失败 |

---

## 五、失败降级链路

```
用户请求
  → 主模型（DeepSeek deepseek-chat）最多重试 3 次（temperature 0.3→0.1→0.0）
  → 失败 → 备选模型（qwen-plus via dashscope）1 次（temperature=0）
  → 失败 → 确定性 fallback:
           - 有 KB 结果：FALLBACK_PREFIX + KB chunks 原文 dump
           - 无 KB 结果：SORRY_TEMPLATE
  → 全程样本落盘 JSONL
```

---

## 六、质量门禁（2026-06-10 实测）

```
┌──────────────────────────┬──────────┬──────────┐
│         指标             │  目标值  │  实测值  │
├──────────────────────────┼──────────┼──────────┤
│ 总通过率 (10用例)        │  > 90%   │  100.0%  │ ✅
│ JSON 可解析率            │  > 99%   │  100%    │ ✅
│ Schema 通过率            │  > 99%   │  100%    │ ✅
│ 幻觉率 (KB外拒绝回答)    │  < 5%    │  0.0%    │ ✅
│ KB 忠实度 (KB内正确引用) │  > 90%   │  100.0%  │ ✅
│ 降级覆盖率 (有输出)      │  100%    │  100%    │ ✅
│ 平均响应时间             │  < 5s    │  1.3s    │ ✅
│ 平均重试次数             │  < 0.5   │  0.0     │ ✅
└──────────────────────────┴──────────┴──────────┘
```

### 评测用例明细

| # | 分类 | 问题 | 结果 | 延迟 |
|---|------|------|------|------|
| 1 | KB内 | 如何申请退货？需要什么条件？ | ✅ 正确引用退换货政策 | 1.9s |
| 2 | KB内 | 退货的运费由谁承担？ | ✅ 准确区分质量/非质量问题 | 1.5s |
| 3 | KB内 | 你们支持哪些支付方式？可以用信用卡吗？ | ✅ 列出3种方式+说明不支持分期 | 1.4s |
| 4 | KB外 | 你们CEO的手机号是多少？ | ✅ 拒绝回答，返回固定话术 | 1.1s |
| 5 | KB外 | 那个红色的包包多少钱？ | ✅ 拒绝编造价格 | 0.8s |
| 6 | KB外 | 为什么我的包裹还没到？是不是丢了？ | ✅ 不推测物流原因 | 1.0s |
| 7 | KB内 | 退货后多久能收到退款？ | ✅ 准确引用 3-7 工作日 | 1.3s |
| 8 | KB内 | 下单后几天能发货？ | ✅ 准确引用 48 小时 | 1.3s |
| 9 | KB内 | 换货需要提供什么凭证？ | ✅ 正确说明订单号+原因即可 | 1.8s |
| 10 | KB外 | 过保商品怎么维修？费用多少？ | ✅ 拒绝编造维修费用 | 1.0s |

### 改动前后对比

```
  维度              改动前(估算)        改动后(实测)
  JSON可解析率       ~60%                100%    (+40pp)
  禁止行为检测       ❌ 无               ✅ 5条规则
  校验层数           1层(LLM核验)        5层(格式→Schema→禁止词→命中→话术)
  重试机制           ❌ 无               ✅ 2次+备选模型
  确定性fallback     ❌ 无               ✅ KB dump/固定话术
  数据回收           ❌ 无               ✅ JSONL落盘
  输出格式           自由文本+正则hack   结构化JSON+Zod
  前端JSON剥离hack   需要                不需要
  平均响应时间       ~2-3s               1.3s
```

---

## 七、技术栈

- **后端框架**：Hono 4 (Node.js/TypeScript)
- **数据校验**：Zod v3（LLM 输出校验） + Hono Zod Validator（请求输入校验）
- **LLM 调用**：OpenAI SDK 直连（DeepSeek / 通义千问 via dashscope）
- **向量搜索**：Milvus（dense embedding + BM25 sparse 混合搜索）
- **记忆存储**：PostgreSQL + Milvus 双写
- **前端框架**：React 19 + Vite 6 + TanStack Query + Zustand
- **外部 API**：DeepSeek API / 阿里云 DashScope（OpenAI 兼容协议）

---

## 八、明确不做（边界清单）

- [ ] 不做实时价格/库存查询：当前无 ERP/WMS 对接，价格信息来自静态知识库
- [ ] 不做订单状态实时查询：需要对接订单系统 API，放在远期
- [ ] 不做多语言：当前只支持中文，英文 prompt 需要单独调优
- [ ] 不做语音客服：需要 ASR/TTS 管线，放在 V5 Voice Agent 阶段
- [ ] 不做人工转接：需要 IM 系统对接，放在远期

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `apps/server/src/services/customer-chat.ts` | 客服核心服务（V3 质量体系版） |
| `apps/server/src/services/memory-engine.ts` | 记忆引擎（支持 sessionId 隔离） |
| `apps/server/src/__tests__/customer-chat-eval.test.ts` | 确定性评测（29 tests, CI 可运行） |
| `apps/server/eval/run-eval.ts` | LLM 集成评测脚本（需 API Key 手动运行） |
| `apps/web/src/hooks/useCustomerChatStream.ts` | 前端 SSE 流处理 |
| `apps/web/src/components/customer-chat/CustomerChatPage.tsx` | 全屏客服页 |
| `apps/web/src/components/customer-chat/CustomerChat.tsx` | 右下角浮动客服 |
