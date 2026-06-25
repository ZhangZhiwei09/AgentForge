# AgentForge 简历评估与面试准备

> 评估日期：2026-06-24
> 定位：2年前端经验，面试 Agent 开发岗位
> 总体评分：8/10

---

## 核心设计与实现（简历项目栏）

**统一 Agent Runtime**：放弃 Chat、Task、Workflow 各自维护执行循环的方案，通过 ExecutionNode 状态机与 Execution Tree 统一执行模型。RunContext 设计为不可变对象并支持级联取消，保证 Tool 执行无法污染上游上下文，中断行为由运行时统一保证。

**混合路由策略**：采用 Rule First + LLM Fallback 架构而非纯 LLM 分类方案。安全审核与转人工请求优先走规则匹配，其余由 Router LLM 输出结构化分类结果，并通过 IntentDetector 与默认 TASK 多级降级，确保 LLM 调用超时或输出异常时不丢弃用户请求。

**双路召回 RAG 引擎**：拒绝纯向量检索方案，采用 Milvus 向量检索与 PostgreSQL BM25 双路召回。针对错误码、产品型号等精确匹配场景保留关键词检索能力，解决语义检索对专有名词命中率不足的问题。

**Multi-Agent 与 Workflow 协同编排**：Multi-Agent 负责任务拆解与决策（Orchestrator、Peer、Debate），Workflow 负责执行调度（DAG 拓扑排序、层级并行、断点续跑）。两者以 Blackboard 共享状态、MessageBus 传递事件，实现任务规划与执行解耦。

**全链路可观测性**：基于 Langfuse 建立 Agent Trace 体系，对路由决策、推理过程、Tool 调用、Token 消耗与执行耗时进行结构化追踪，支持按 RunId 回放完整执行链路，替代传统日志的碎片化调试方式。

---

## 核心抽象解释（面试被问 "ExecutionNode 和 RunContext 是什么" 时用）

### ExecutionNode — 一次"运行"的生命周期管理器

每次调用 Agent 对话、执行一个 Workflow、调用一个 Tool——都是一棵 ExecutionNode 树。它做三件事：

1. **管状态**：CREATED → RUNNING → 最终到 COMPLETED / FAILED / CANCELLED / TIMEOUT 之一，终态不可逆转，非法跳转直接拒绝
2. **管父子关系**：一个 Agent 步骤内部调用 Tool，Tool 就是 Agent 的子节点。父节点取消时，所有子节点自动级联取消
3. **管输出缓冲**：每个节点有自己的 OutputBuffer，流式 token 往里写，上层统一往外读

```
一次 Agent 对话的执行树：
  Run(root)                    ← CREATED → RUNNING → COMPLETED
  ├── Router                  ← 路由分类（SAFETY/CHAT/TASK/HUMAN）
  ├── AgentExecutor(ReAct)    ← 思考→工具调用→观察→响应
  │   ├── Tool: search_kb     ← 搜索知识库
  │   ├── Tool: check_order   ← 查询订单
  │   └── CitationVerifier    ← 校验引用
  └── Responder               ← 组装最终回复
```

### RunContext — 一次"运行"的身份和权限

每次执行都带着一个 RunContext，三个字段，全部不可变：

```
RunContext {
  runId: "abc-123",                         // 唯一标识
  ancestry: ["root", "agent", "tool-search"], // 在执行树里的位置
  signal: AbortSignal                       // 外部取消信号
}
```

关键设计：Tool 拿到的是 RunContext 的冷冻副本（Object.freeze），改不了、也看不到不该看的东西。Tool 想调用另一个 Tool？必须通过 ToolRegistry，不能直接引用——RunContext 只给身份，不给权力。

### 为什么搞这两个东西？

重构之前，ChatService、AgentService、WorkflowService 各有一套状态管理和中断处理。ChatService 用 flag 表示"运行中"，AgentService 用字段，WorkflowService 用数据库状态——行为不一致，中断处理各写各的。

统一之后：所有东西都是一棵 ExecutionNode 树，所有节点都带着 RunContext。新增一个场景——比如语音对话——不需要再写状态管理代码，直接复用。

---

## 分模块 STAR（面试深度展开用）

---

### 1. Agent Runtime 统一执行引擎

**S（情境）**：项目初期存在多条执行路径——ChatService 处理对话、AgentService 处理任务、VoiceService 处理语音——各自维护一套状态管理和错误处理逻辑。新增一个场景需要复制大量样板代码，且各路径的行为不一致（有的支持中断、有的不支持）。

**T（任务）**：设计一套统一的运行时抽象，所有 Agent 类型共享同一套状态机、上下文模型和输出缓冲。目标：新增场景只需注册 Tool 或 Provider，不写新的执行循环。

**A（行动）**：

- ExecutionNode 状态机定义了 CREATED→RUNNING→COMPLETED/FAILED/CANCELLED/TIMEOUT 五态，终态不可逆，非法跳转直接拒绝
- Interrupting 作为过渡态（用户点了停止但 LLM/Tool 可能还在收尾），UI 展示 "Stopping..."
- RunContext 设计为全部 readonly + Object.freeze，子节点取消自动级联到所有后代——借鉴浏览器 AbortController 模式
- OutputBuffer 纯缓冲抽象，不绑定持久化、不绑定生命周期，Chat/Voice/Workflow 复用
- ExecutionScope 作为聚合入口，将 Context + Controller + Buffer 组合为一个执行单元

**R（结果）**：

- 代码量：runtime/ 目录 5 个文件，核心逻辑 < 300 行
- 后续新增 Agent 场景时，直接复用 RunContext + OutputBuffer + ExecutionScope，零额外状态机代码
- 所有执行路径获得统一的中断行为——级联取消是设计保证，不是各路径各自实现的约定

**映射到代码**：

```
apps/server/src/runtime/
├── context.ts      # RunContext 不可变上下文 + 运行树
├── controller.ts   # ExecutionNode 状态机
├── buffer.ts       # OutputBuffer 纯缓冲
└── scope.ts        # ExecutionScope 聚合入口
```

---

### 2. 4路由意图分类器

**S（情境）**：用户输入种类繁多——从正常业务咨询到恶意越狱攻击到简单打招呼。如果在业务 Agent 的 System Prompt 里混入安全审核指令，既不专业也不可靠（Prompt Injection 可能绕过）。需要一层独立的路由层，在请求进入执行引擎之前完成分流。

**T（任务）**：设计一个高性能、高可靠性的意图分类器，将用户请求分流到 SAFETY（安全违规）/ CHAT（闲聊）/ TASK（任务执行）/ HUMAN（人工转接）四条路径。要求：安全检测零延迟、不可绕过；路由失败不丢请求。

**A（行动）**：

- Rule First 关键词规则：安全违规关键词（越狱、攻击、诈骗等）→ SAFETY；转人工关键词 → HUMAN。纯内存匹配，零延迟，不可被 LLM Prompt Injection 绕过
- 规则未命中的交给 Router LLM 做结构化分类，Zod Schema 约束输出 `{route, confidence, reasoning}`
- confidence < 0.7 回退到 IntentDetector（基于正则），LLM 调用失败也回退
- IntentDetector 内部映射到 RouteName，默认兜底 TASK

**R（结果）**：

- 安全/转人工场景绝对零延迟（无 LLM 调用）
- 三次降级保证（规则→LLM→IntentDetector→默认TASK），零请求丢失
- Router LLM 输出仅 ~60 tokens（结构化 JSON），几乎不影响首字延迟

**映射到代码**：

```
apps/server/src/services/agent-runtime/router.ts
```

---

### 3. Multi-Agent 协作系统

**S（情境）**：单 Agent 在处理复杂任务时存在明显的瓶颈——比如"分析这份代码的安全性、性能和可维护性"，单 Agent 串行处理三个维度耗时长，且不同维度的推理可能互相干扰（安全审查的思维模式和性能优化的思维模式不同）。

**T（任务）**：设计一套 Multi-Agent 协作框架，支持多种协作模式，Agent 之间可以通信、共享上下文、避免状态污染。目标是：复杂任务可以拆解后由多个专职 Agent 并行处理，通过结构化的协作协议汇总结果。

**A（行动）**：

- Orchestrator 模式：主 Agent 做 Plan（LLM 输出结构化子任务列表：task_id/描述/依赖关系/所需Tool），按 DAG 拓扑排序执行，无依赖子任务并行分发，结果写回 Blackboard，主 Agent 最后 Summarize
- Peer 模式：多 Agent 水平讨论 N 轮，每轮各自从 Blackboard 读取上下文后给出观点，超时或达到共识阈值后投票决策
- Debate 模式：两个 Agent 各执一方对抗辩论，Judge Agent 观察完整辩论后裁决
- Blackboard 设计：每个 Agent 写入时带 namespace，读取时合并所有 namespace 但不可覆盖他人写入，读不污染写
- MessageBus：Agent 间异步消息通道，支持定向消息和广播

**R（结果）**：

- Orchestrator 模式将复杂任务从串行改并行后，执行时间与子任务中最慢的一个成正比，而非所有子任务之和
- Code Review 场景用 Peer 模式三 Agent 并行审查（安全/性能/可维护性），比单 Agent 串行审查更全面，不同维度的发现不会相互压制
- Blackboard 的 namespace 隔离避免了 Agent 之间的状态污染

**映射到代码**：

```
apps/server/src/teams/
├── executor.ts    # 协作模式分发
├── blackboard.ts  # 共享记忆（namespace 隔离）
├── message-bus.ts # Agent 间通信
└── modes/
    ├── orchestrator.ts  # 主从模式
    ├── peer.ts          # 平行讨论+投票
    └── debate.ts        # 对抗辩论+裁判
```

---

### 4. RAG 双路召回知识引擎

**S（情境）**：纯向量检索在某些场景下表现不佳——专有名词、产品型号、错误码等精确匹配场景，语义相似度无能为力。同时知识库文档质量参差不齐，低质量文档的 chunk 混入检索结果会降低 Agent 回答质量。

**T（任务）**：构建一个高质量 RAG 引擎，支持语义检索和关键词检索双路互补，配合文档解析 Pipeline 和质量门控机制，确保注入 Agent 上下文的信息既相关又可靠。

**A（行动）**：

- 双路召回：语义路走 Milvus 向量检索（embedding → cosine similarity），关键词路走 PostgreSQL 倒排索引 BM25（term → termFreq），两路结果去重合并
- 文档解析 Pipeline：PDF 解析（pdf-parser）→ 文本清洗（cleaner：去噪/归一化/段落修复）→ 分块切分（tokenizer-aware splitter，按语义边界切分不按字符数硬切）
- 质量门控：每个 chunk 标记 quality_label（good/low），低质量 chunk 在检索排序时降权
- KnowledgeContextBuilder：不简单拼接 chunk，按 Source → Header → Chunks 层级组织，带溯源标记，支持 CitationVerifier 校验引用真实性

**R（结果）**：

- 双路召回在精确匹配场景（产品型号 ZX-9000、错误码 E10024）下的命中率显著优于纯向量检索
- 文档解析 Pipeline 自动处理了格式混乱的 PDF，质量标签过滤掉了无意义的页眉页脚 chunk
- CitationVerifier 能检测 Agent 回复中的虚假引用（编造不存在的文档内容）

**映射到代码**：

```
apps/server/src/services/
├── knowledge.ts              # RAG 核心
├── knowledge-ingestion.ts    # 文档入库
├── embeddings.ts             # 向量化
├── milvus.ts                 # Milvus 客户端
├── text-splitter.ts          # 语义分块
├── tokenizer.ts              # Token 计数
└── document-parser/          # 文档解析 Pipeline
    ├── parsers/pdf-parser.ts
    ├── parsers/text-parser.ts
    └── registry.ts
```

---

### 5. DAG Workflow 编排引擎

**S（情境）**：真实业务场景中，Agent 调用往往是多步骤的——例如客服工单处理需要：查询用户信息 → 查询订单 → 查询物流 → 判断是否需要升级 → 汇总回复。这些步骤之间存在依赖关系，部分可并行。如果每次都在应用层硬编码这些流程，维护成本极高且不可复用。

**T（任务）**：设计一个声明式 Workflow 引擎，用户通过 JSON Definition 定义步骤和依赖关系，引擎自动进行拓扑排序、并行执行、状态持久化。支持条件分支、人工审批、断点续跑。

**A（行动）**：

- DAG 核心：`topologicalSort()` 将步骤按依赖关系分层，检测循环依赖。同层级步骤 `Promise.allSettled` 并发执行，失败不阻塞同层其他步骤
- 6 种步骤 Handler：Agent 步骤（嵌入 ReAct 循环）、Tool 步骤（调用 ToolRegistry）、Condition 步骤（表达式求值+分支路由）、Parallel 步骤（多分支并发）、HumanApproval 步骤（暂停等用户决策）、Transform 步骤（merge/map/filter 数据变换）
- 断点续跑：每步完成后写 Checkpoint（completedSteps + variables + stepResults），暂停/崩溃后从 Checkpoint 恢复，`executeWithSkip()` 跳过已完成步骤
- 变量系统：`{{var}}` 模板引擎支持跨步骤引用（`{{step_id.output.field}}`）、嵌套路径解析、类型自动推断。SafeEvaluator 支持比较运算符和逻辑表达式
- 重试策略：fixed/linear/exponential 三种退避，支持超时控制、失败降级到 fallback_step

**R（结果）**：

- 声明式定义使非开发人员也能编排 Agent 工作流
- DAG 拓扑排序 + 层级并行使得无依赖步骤自动并发，无需手动管理 Promise
- 断点续跑确保长时间 Workflow（例如多文档处理、批量数据清洗）在服务重启后从中断点继续，不丢进度
- 3 套内置模板（内容摘要/数据分析/代码审查）覆盖常见场景，代码审查模板展示了 Parallel 步骤 + depends_on 依赖的典型用法

**映射到代码**：

```
apps/server/src/workflows/
├── dag-executor.ts     # 拓扑排序 + 层级并行执行
├── service.ts          # CRUD + 执行流 SSE + 暂停/恢复/取消
├── step-runner.ts      # 超时 + 重试 + 降级
├── checkpoint.ts       # 断点数据结构
├── variable-resolver.ts # {{var}} 模板引擎 + SafeEvaluator
├── templates.ts        # 3 套内置模板
├── schema.ts           # Zod 校验
└── handlers/
    ├── agent-step.ts
    ├── tool-step.ts
    ├── condition-step.ts
    ├── parallel-step.ts
    ├── human-approval-step.ts
    └── transform-step.ts
```

---

## 评分总览

| 维度 | 分数 | 一句话 |
|------|------|--------|
| Runtime 设计 | 9/10 | ExecutionNode 状态机 + RunContext 不可变隔离 + 级联取消 |
| 路由分类 | 8/10 | Rule First + LLM Fallback，三次降级零请求丢失 |
| Agent 执行引擎 | 8/10 | 统一 ReAct 循环，ToolDynamic + ContextStructured + CitationVerified |
| Multi-Agent 协作 | 9/10 | Orchestrator/Peer/Debate + Blackboard + MessageBus，三种模式完整实现 |
| RAG 引擎 | 8/10 | 双路召回（向量+倒排），文档解析Pipeline，质量门控 |
| Workflow 引擎 | 8/10 | DAG拓扑+层级并行，6种Step，Checkpoint+Rerty |
| Tool 体系 | 7/10 | Builtin/Business分层完备，但工具数量有限 |
| 记忆系统 | 7/10 | 三种记忆类型+压缩，但缺少遗忘/衰减策略 |
| 工程规范 | 7/10 | Zod/SafeParse/降级链/Langfuse/25测试，测试覆盖不足 |

**总体：8/10** — 个人项目、2年经验基准。扣分项：单人体量、缺少生产验证、测试覆盖率。

---

## 面试追问预案

### Q: ReAct 循环中 Agent 决策出错怎么恢复？

三级降级链：ReAct 重试（指数退避）→ 简化 Prompt 重试 → 硬编码兜底文案。ErrorClassifier 先分类（LLM超时/JSON解析失败/Tool异常/权限拒绝），不同错误走不同恢复路径。

### Q: Orchestrator 怎么拆分任务？

主 Agent 先做 Plan 阶段，LLM 输出结构化子任务列表 `[{task_id, description, depends_on, tools}]`。DAG 拓扑排序后，无依赖的并行分发，有依赖的等前驱完成。结果写 Blackboard，主 Agent 最后 Summarize。不需要硬编码流程——LLM 动态生成执行计划。

### Q: RAG 双路召回相比纯向量检索好在哪？

纯向量检索对专有名词、产品型号、错误码无能为力（语义空间不区分 "E10024" 和 "E10025"）。倒排索引的 BM25 做精确词匹配，与向量语义检索互补。两路去重合并后，KnowledgeContextBuilder 按结构化层级注入 Agent 上下文，带溯源标记。

### Q: Workflow 断点续跑是怎么实现的？

每步执行完写入 Checkpoint（completedSteps IDs + stepResults 快照 + variables 快照）。崩溃恢复时，`executeWithSkip()` 接受已完成步骤的 ID Set，拓扑排序后过滤掉已完成的，从剩余步骤继续执行。StepResults 和 Variables 从 Checkpoint 完整恢复。

### Q: 这个项目的不足？

- RAG：缺少 Query Rewrite 和 HyDE 等高级检索优化
- Tool：工具数量和种类不够丰富
- Multi-Agent：消息协议可以标准化（对标 Google A2A）
- 生产验证：缺少真实流量的压测数据和在线指标
