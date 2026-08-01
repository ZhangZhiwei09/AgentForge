# DiagnosisMode：多 Agent 协作诊断模式

> 版本: v1.0 | 日期: 2026-07-05 | 作者: Architect
> 状态: Draft，待 Review
> 依赖: Teams 系统（Blackboard + MessageBus + TeamExecutor）
>
> **⚠️ 架构变更（2026-07）**: Orchestrator / Peer / Debate 模式已移除（见 `docs/decisions/adr-001-remove-langgraph.md` 和 `docs/design/platform-service-split-plan.md` 决策 #3）。Diagnosis 实际实现已改为 Agent Runtime 第 5 条路由（`DiagnosisRouteAgent`），而非 Teams 系统中的独立 Mode。本文档中的模式对比表和集成方案已过时，保留作为原始设计参考。

---

## 1. 背景与目标

### 1.1 问题

当前核身客服诊断流程（`DiagnosisService`）是单 Agent 规则流水线。单 Agent 的局限在于：
- 只能从知识库检索 + 模板拼装，缺少真正的排查推理
- 无法区分"前端问题"和"后端问题"——一个 Agent 同时面对两个知识域，容易混淆因果
- 遇到需要监控数据交叉验证的场景，无法做到"前端发现现象、后端确认根因"

### 1.2 目标

在 Teams 多 Agent 系统中新增 `DiagnosisMode`，实现**前端先行、后端待命的逐级升级诊断**：

- 简单问题由前端 Agent 独立解决，不引入额外耗时
- 复杂问题自动升级到后端，前后端结论交叉验证
- 冲突时通过评分机制加权，无法判定时转人工
- 复用 Teams 现有基础设施（Blackboard、MessageBus、SSE 流式、持久化），不新建执行轨道

### 1.3 不做的事

- 不包含客户端 Agent（iOS/Android/小程序端，本次不在范围）
- 不修改现有 Diagnosis Service（LangGraph 规则流水线保持独立运行，DiagnosisMode 是替代演进路径）
- 不引入新的持久化层（复用 `agentTeamRun` 表）

---

## 2. 核心设计

### 2.1 模式对比

| | Orchestrator | Debate | Peer | **DiagnosisMode** |
|---|---|---|---|---|
| 执行顺序 | 领导串行派活 | 正反方并行辩论 | 全员并行广播 | **前端先行，后端待命** |
| 决策方式 | 领导统一调度 | 裁判裁决 | 自然收敛 | **前端自评升级 + 领导评分汇总** |
| 简单场景 | 领导仍跑一轮 | 必须三轮 | 必须一轮 | **前端直接回，零额外开销** |
| 冲突处理 | 无 | 裁判选赢家 | 无 | **四维评分 + 低分转人工** |

### 2.2 整体流程

```
用户问题
    ↓
【Phase 1】前端 Agent 排查
    ├─ 调监控工具、查日志、追踪业务流程
    ├─ 输出 { conclusion, evidence, need_escalation, escalation_reason }
    └─ 判断 need_escalation
         ├─ false → 前端结论直接返回 → END
         └─ true → 进入 Phase 2
              ↓
【Phase 2】后端 Agent 独立排查
    ├─ 拿到原始问题 + 前端排查上下文（不受前端结论引导）
    ├─ 调后端监控工具、查 trace、查接口耗时、查错误码分布
    └─ 输出 { conclusion, evidence }
              ↓
【Phase 3】领导汇总
    ├─ 对前端 + 后端结论分别做四维度评分
    ├─ 分差 ≥ 3 → 以高分结论为主
    ├─ 分差 < 3 → 如实展示双方观点
    ├─ 双方总分 < 3 → 转人工
    └─ 输出最终诊断
```

---

## 3. Phase 1：前端 Agent 排查

### 3.1 角色定义

**System Prompt 要点**：

- 你是核身业务前端排查专家
- 精通 H5/Web 端浏览器 API（getUserMedia、WebRTC、Canvas）、摄像头权限策略、CORS、WebSocket
- 可以调用监控系统查询用户操作日志、前端错误日志、业务流程追踪
- 你的目标是：通过监控数据追踪用户完整的操作链路，定位失败发生在哪个阶段、什么环节

**工具集**：

- `query_trace_log`：按 traceId/orderId 查询完整业务流程日志
- `query_merchant_metrics`：按商户维度查询通过率、错误分布
- 知识库检索：前端相关的浏览器兼容性、SDK 接入文档、常见错误码

### 3.2 排查目标

前端 Agent 需要回答三个问题：

1. 用户的业务流程走到了哪一步？（发起刷脸 → 摄像头授权 → 活体采集 → 上传 → ...）
2. 在哪个阶段中断的？中断时前端捕获到了什么？
3. 根据已有信息，能否确定根因？

### 3.3 结构化输出

前端 Agent 必须以结构化 JSON 输出：

```json
{
  "conclusion": "用户进入了活体采集阶段，3 秒后连接断开，页面提示'刷脸失败'。前端日志显示 getUserMedia 返回成功，摄像头正常工作。WebSocket 在活体采集阶段断开，断开前无前端错误日志。",
  "evidence": [
    { "type": "log", "detail": "getUserMedia success, 摄像头权限已授权" },
    { "type": "trace", "detail": "业务流程走到了 liveness_capture 阶段" },
    { "type": "observation", "detail": "WebSocket 在活体采集开始 3 秒后断开，断开码 1006" }
  ],
  "need_escalation": true,
  "escalation_reason": "monitoring_indicates_backend",
  "context_for_backend": {
    "traceId": "abc123",
    "failedStage": "liveness_capture",
    "clientType": "H5",
    "timestamp": "2026-07-05T14:30:00+08:00",
    "frontendObservation": "摄像头权限正常，WebSocket 在采集阶段异常断开"
  }
}
```

### 3.4 升级判断

**规则触发**（明确场景，不走 LLM 自评）：

| 规则 | 逻辑 | 示例 |
|---|---|---|
| 发现后端错误码 | 前端日志/监控中出现 `FACE_TIMEOUT`、`SERVER_ERROR`、`INTERNAL_ERROR` 等 | 直接升级 |
| 请求已到达后端但返回异常 | trace 显示请求到了后端，但返回了非预期状态 | 直接升级 |
| 业务流程走到了后端依赖阶段 | 用户已过摄像头阶段，进入了活体算法/服务端校验阶段 | 直接升级 |

**LLM 自评触发**（规则未命中时的兜底）：

前端 Agent 输出中的 `need_escalation` 字段由 LLM 自己判断。当规则未触发升级且 `need_escalation = false` 时，前端结论直接返回。

### 3.5 快速通道（不升级）

```
用户问："H5 摄像头打不开怎么办"
    ↓
前端 Agent 排查：
    → 规则未触发升级（无后端错误码、无 trace 异常）
    → LLM 自评 need_escalation = false
    → 输出结论："用户需确认浏览器已授予摄像头权限，且在 HTTPS 环境下访问。
       Safari 需在用户手势事件中调用 getUserMedia。"
    ↓
直接返回 → END
```

---

## 4. Phase 2：后端 Agent 独立排查

### 4.1 角色定义

**System Prompt 要点**：

- 你是核身业务后端排查专家
- 精通服务端监控指标、trace 链路、错误码分布、接口耗时分析
- 你可以查询后端监控系统、trace 系统、错误码知识库
- 你的目标是：基于原始用户问题和服务端数据，独立形成判断，不被前端结论带偏

**工具集**：

- `query_trace_log`：查询完整后端调用链路
- `query_merchant_metrics`：查询商户维度和全局维度指标
- `query_error_code_distribution`：查询错误码分布和趋势
- 知识库检索：后端错误码文档、服务端架构文档、已知问题库

### 4.2 输入

后端 Agent 收到两份信息：

1. **原始用户问题**（不被前端加工过）
2. **前端排查上下文**（`context_for_backend`：traceId、失败阶段、端类型、时间戳、前端观察）

**注意**：后端 Agent 不直接看到前端 Agent 的 `conclusion`（结论），只看到 `context_for_backend`（事实性数据）。目的是避免后端的判断被前端结论引导。领导在 Phase 3 才把两条结论放在一起比较。

### 4.3 结构化输出

```json
{
  "conclusion": "活体算法处理耗时 2.8s，超过阈值 2.5s，服务端返回 FACE_TIMEOUT。P99 延迟 4.2s，其中网络传输占用 1.2s，算法处理占用 2.8s，算法排队占用 0.2s。根因是算法处理超时。",
  "evidence": [
    { "type": "trace", "detail": "traceId abc123, 服务端接收时间 14:30:01, 返回 FACE_TIMEOUT 时间 14:30:04" },
    { "type": "metric", "detail": "P99 liveness_algorithm_duration = 2.8s, 阈值 = 2.5s" },
    { "type": "distribution", "detail": "FACE_TIMEOUT 占该商户今日失败量的 42%" }
  ]
}
```

---

## 5. Phase 3：领导汇总与冲突评分

### 5.1 领导的角色

领导不是调度器（Orchestrator 的调度职责在 DiagnosisMode 中不存在），领导只做一件事：**证据对齐与加权汇总**。

领导的输入：
- 原始用户问题
- 前端 Agent 的 `{ conclusion, evidence }`（完整）
- 后端 Agent 的 `{ conclusion, evidence }`（完整）

### 5.2 四维度评分体系

**每条结论打四个维度分，满分 9 分。**

| 维度 | 含义 | 评分标准 |
|---|---|---|
| **证据等级** | 结论有硬数据支撑吗 | 3 = 有监控指标/日志/trace 数据；2 = 有知识库文档引用；1 = 纯推理/经验判断；0 = 纯猜测 |
| **可验证性** | 结论包含可验证的具体信息吗 | 3 = 含具体数字（延迟、错误码、时间戳）；1 = 方向性判断；0 = 无法验证 |
| **覆盖度** | 结论解释了全部症状吗 | 2 = 解释了所有症状；1 = 部分解释；-1 = 与某些症状矛盾 |
| **领域权威** | 结论是否在该角色擅长的领域内 | 1 = 是（后端关于延迟=后端 Agent +1；前端关于浏览器行为=前端 Agent +1）；0 = 否 |

### 5.3 评分示例

**场景：H5 活体刷脸失败**

```
前端 Agent 结论：
  "疑似 WebSocket 连接中断导致失败"
  证据等级：1（无确切的 WS 中断日志）
  可验证性：1（方向性判断）
  覆盖度：1（解释了"失败"，未解释为何 getUserMedia 成功但后续断开）
  领域权威：+1（前端连接问题）
  总分：4

后端 Agent 结论：
  "活体算法处理 2.8s，超过 2.5s 阈值，返回 FACE_TIMEOUT。
   服务端主动关闭连接后前端看到断开。"
  证据等级：3（trace + 错误码 + 耗时数据）
  可验证性：3（具体数字：2.8s, 2.5s, FACE_TIMEOUT）
  覆盖度：2（解释了失败原因 + 解释了前端的连接断开现象）
  领域权威：+1（后端延迟问题）
  总分：9
```

**分差 = 9 - 4 = 5 ≥ 3 → 以后端结论为主。**

前端结论标注为："已排查，但缺乏具体数据支撑。后端监控数据解释了前端观察到的现象（连接断开是服务端超时后的正常行为）。"

### 5.4 三种处理路径

| 条件 | 处理 |
|---|---|
| 分差 ≥ 3 | 以高分结论为主，低分结论标注为"已排查，证据不支撑"或"可能性较低" |
| 分差 < 3（双方都有一定证据） | 如实展示双方观点，标注分歧和各自依据，不强行选一边 |
| 双方总分 < 3 | 信息不足，触发转人工。输出已收集的已知信息和需要用户补充的字段 |

### 5.5 转人工时的输出

```json
{
  "status": "needs_human",
  "collected_info": {
    "frontend_finding": "前端未发现明显异常",
    "backend_finding": "后端监控无对应错误记录"
  },
  "missing_fields": ["traceId", "具体失败时间", "用户设备型号和浏览器版本"],
  "message": "当前信息不足以自动定位根因，已转人工处理。建议补充 traceId 和具体失败时间后重新排查。"
}
```

---

## 6. 数据结构

### 6.1 Blackboard Keys

| Key | 写入者 | 内容 |
|---|---|---|
| `task` | system | 原始用户问题 |
| `entities` | system | 预提取的结构化实体（merchantId, traceId, errorCode, clientType, product） |
| `frontend_conclusion` | Frontend Agent | `{ conclusion, evidence, need_escalation, escalation_reason }` |
| `context_for_backend` | Frontend Agent | `{ traceId, failedStage, clientType, timestamp, frontendObservation }` |
| `backend_conclusion` | Backend Agent | `{ conclusion, evidence }` |
| `scoring_result` | Leader | `{ findings: [...], resolution, final_diagnosis, confidence }` |

### 6.2 Team Definition

```json
{
  "name": "核身诊断团队",
  "collaborationMode": "diagnosis",
  "agents": [
    {
      "name": "frontend_agent",
      "displayName": "前端排查专家",
      "systemPrompt": "...",
      "tools": ["query_trace_log", "query_merchant_metrics", "search_knowledge_base"],
      "maxIterations": 5
    },
    {
      "name": "backend_agent",
      "displayName": "后端排查专家",
      "systemPrompt": "...",
      "tools": ["query_trace_log", "query_merchant_metrics", "query_error_code_distribution", "search_knowledge_base"],
      "maxIterations": 5
    },
    {
      "name": "leader",
      "displayName": "诊断汇总",
      "systemPrompt": "...",
      "tools": [],
      "maxIterations": 3
    }
  ],
  "maxTotalIterations": 3,
  "onFailure": "stop"
}
```

### 6.3 DiagnosisMode 的 CollaborationModeExecutor 接口

实现现有的 `CollaborationModeExecutor` 接口：

```typescript
export class DiagnosisMode implements CollaborationModeExecutor {
  async *execute(
    definition: TeamDefinition,
    task: string,
    context: ExecutionContext,
  ): AsyncGenerator<TeamStreamEvent>;
}
```

---

## 7. 集成点

### 7.1 与现有 Teams API 的关系

- `POST /api/teams/:id/run` — 已有端点，`collaborationMode = "diagnosis"` 的 Team 定义会路由到 `DiagnosisMode`
- `POST /api/teams/runs/:runId/cancel` — 复用已有取消逻辑
- `POST /api/teams/runs/:runId/pause` — 复用已有暂停逻辑
- GET 端点（templates、runs、history）— 复用

### 7.2 不需要改动的部分

- `TeamExecutor` — 在 `modeExecutors` Map 中新增 `"diagnosis"` 条目即可
- `TeamService` — 不需要改动，它只负责 CRUD + run 生命周期 + checkpoint
- `Blackboard` / `MessageBus` — 不变
- `AgentService` — 每个 Agent 仍通过 `AgentService.run()` 执行

### 7.3 需要新增/改动的部分

| 文件 | 改动 |
|---|---|
| `teams/modes/diagnosis.ts` | **新增** DiagnosisMode 实现 |
| `teams/executor.ts` | 新增 `"diagnosis"` 注册 |
| `teams/templates.ts` | 新增 Diagnosis 内置模板 |
| `teams/modes/types.ts` | 无改动，复用现有接口 |
| `shared-types` | 无需新增，TeamStreamEvent 已足够 |

---

## 8. 验证标准

### 8.1 功能验证

- [ ] 简单问题（前端能独立解决）→ 不升级，2s 内返回，cost ≤ 1×
- [ ] 发现错误码 → 自动升级到后端，前端 + 后端并行不重复工作
- [ ] 前端查不出 → LLM 自评触发升级，后端 = 独立排查
- [ ] 矛盾结论 + 分差 ≥ 3 → 以高分为主
- [ ] 矛盾结论 + 分差 < 3 → 如实展示分歧
- [ ] 双方总分 < 3 → 转人工，输出缺失字段
- [ ] SSE 事件流正确（team_started → agent_started → agent_completed → team_completed）

### 8.2 性能验证

- [ ] 简单问题延迟 ≤ 3s（单 Agent 执行 + SSE 流式）
- [ ] 升级问题延迟 ≤ 8s（前端 + 后端 + 领导，串行累积 ≤ 8s）

### 8.3 回归验证

- [ ] 现有 Orchestrator / Peer / Debate Mode 不受影响
- [ ] 现有 Diagnosis Service (`/api/diagnosis/query`) 独立端点正常工作

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 自评过度自信（明明没查到硬说解决了） | Phase 3 评分兜底——如果前端结论分数低于 3 分，即使没升级也会标记为"证据不足" |
| LLM 打分不稳定（同一结论两次打分不同） | 不在运行时做二次验证，接受单次评分的合理偏差（±1 分在阈值内） |
| 后端排查耗时过长 | 后端 Agent maxIterations 限制为 5，工具调用带超时 |
| 两个 Agent 都查不出来（双方 < 3 分率高） | 转人工，记录案例用于优化知识库和工具覆盖 |
