# MCP 监控管线收尾计划（可选事项）

> 状态：**待评审**（2026-08-04）
> 前置：MCP 监控管线主流程已实现并验证（Stage 1–6 完成）——
> Python 模拟监控 MCP server、TS `MonitoringMcpClient`、两条诊断路径（multi-agent toolRegistry / DiagnosisService 图）统一走 MCP、旧 mock 已清理。
> 范围：`apps/server`（dev 脚本 + 可观测性）、`apps/server-py`（package.json dev 脚本）、`docs/operations/development.md`。
> 本计划仅覆盖主计划中**延期的可选事项**，不含新的架构决策。参照 CLAUDE.md 可直接进入 Implementation（Config / Docs / 小型功能）。

## 1. 背景与目标

主计划落地后，还有三项不影响核心功能、可独立推进的可选事项：

1. **Dev 启动脚本**：当前模拟监控 MCP server 只被 e2e 测试 spawn、或靠手动 `uv run python -m src.mcp.monitoring.server --port 3100` 启动，没有正式 dev 入口。开发者要本地联调诊断链路时缺少一键启动。
2. **MCP 调用可观测性（Langfuse span 嵌套）**：两条路径对 MCP 调用的可观测覆盖不一致（详见 §3），需要补平。
3. **开发文档**：`docs/operations/development.md` 补充 MCP server 的本地启动说明。

目标：

- 提供一个与现有 `py:dev` / `py:test` 命名一致的 dev 脚本，`pnpm py:mcp` 一键拉起监控 MCP server（默认 `127.0.0.1:3100`，端口/API Key 可配）。
- 让**两条诊断路径**的 MCP 调用都以 Langfuse generation 形式出现在诊断 trace 下，可复现「某次诊断查询 → 调了几次监控、耗时多少、返回什么」。
- 不引入手工 Span、不改变现有可观测性抽象（遵循 `provider.ts`「禁止业务代码手工创建 Span」约束）。

## 2. 现状分析（关键事实）

| 项 | 现状 | 影响 |
|---|---|---|
| Python server 启动 | `apps/server-py/src/mcp/monitoring/server.py:main()`：`--host`/`--port` + 环境变量 `MCP_MONITORING_PORT`（默认 3100）、`MCP_API_KEY`（可选 Bearer 认证）；无 npm/turbo 任务 | 只需加一条脚本，无代码改动 |
| server-py package.json | `dev`（uvicorn :8004）、`test`（pytest）、`lint`（ruff） | 新增 `mcp:monitoring` 脚本，命名对齐现有 |
| 根 package.json | `py:dev` / `py:test` 走 `pnpm --filter @agentforge/server-py ...` | 新增 `py:mcp`，命名对齐 |
| Path 1（multi-agent teams）可观测性 | `legacy-agent-runner.ts:340` 对每次原生 tool 执行包一层 `trace.generation({ name: "tool-${tc.name}" })`，含 input args、output content、durationMs；`query_trace_log` 已是 RegisteredTool，自动落在该路径 | **Path 1 已覆盖**，MCP 调用天然嵌套在 agent trace 下，无需改动 |
| Path 2（DiagnosisService 图）可观测性 | `routes/diagnosis.ts` 直调 `diagnosisService.run()`；graph / monitoring-tools / nodes **无任何 trace / generation / 观测埋点** | **缺口**：Path 2 的 MCP 调用在 Langfuse 里不可见 |
| 可观测性抽象 | `provider.ts`：`ObservabilityProvider.createTrace` → `ObservabilityTrace.generation()`；**明确禁止手工 Span**（Span 由未来 RuntimeEvent 驱动） | Path 2 补观测只能用 `generation()`，不能用 span |
| DiagnosisService 运行形态 | `graph.ts` 线性流水线（classify → entities → fields → retrieve → decide → query_monitoring → merge → generate → self_check）；`generateDiagnosisNode` 为**模板渲染，无 LLM 调用** | 图内唯一外部调用 = 知识库检索 + MCP 监控，观测点集中 |
| Trace 传递模式 | `runtime/scope.ts`：trace 注入后 readonly，默认 undefined → no-op | Path 2 可复用「可选参数传 trace」模式，默认不开启不影响现有调用 |

## 3. 事项 A：MCP server dev 启动脚本

**改动清单（均为 Config/Docs，无业务代码改动）：**

1. `apps/server-py/package.json` 新增脚本：
   ```json
   {
     "mcp:monitoring": "uv run python -m src.mcp.monitoring.server"
   }
   ```
   - 默认即 `127.0.0.1:3100`（`server.py:main` 读 `MCP_MONITORING_PORT`，缺省 3100）；联调时用环境变量改端口，无需改脚本。
2. 根 `package.json` 新增脚本（对齐 `py:dev` / `py:test`）：
   ```json
   {
     "py:mcp": "pnpm --filter @agentforge/server-py mcp:monitoring"
   }
   ```
3. `docs/operations/development.md` 新增「监控 MCP Server（模拟）」小节：
   - 启动：`pnpm py:mcp`（或 `pnpm --filter @agentforge/server-py mcp:monitoring`）
   - 端口：`MCP_MONITORING_PORT`（默认 3100）；TS 端对应 `MCP_MONITORING_URL`（默认 `http://127.0.0.1:3100/mcp`）
   - 认证：设 `MCP_API_KEY` 开启 Bearer 校验，TS 端配 `MCP_MONITORING_API_KEY`；开发环境留空关闭
   - 验证：`curl http://127.0.0.1:3100/mcp`（协议握手）或跑 `diagnosis.e2e.test.ts`

**不做 turbo task 的原因**：根 `dev` 脚本用 turbo 并行拉起多个**常驻**服务，监控 MCP server 只有做诊断联调时才需要，纳入 turbo 会让所有开发者无差别多起一个进程。脚本 + 文档即可，属可选（需要时可后续加 `turbo dev --filter=@agentforge/server-py` 的 persistent task）。

## 4. 事项 B：MCP 调用可观测性（Langfuse generation 嵌套）

### 4.1 结论：只需补 Path 2

- Path 1 已由 `legacy-agent-runner.ts` 的工具 generation 覆盖，**不做改动**。
- Path 2（DiagnosisService 图）从 route 到 graph 到 monitoring-tools 全程无观测，是唯一缺口。

### 4.2 设计约束

- 遵循 `provider.ts`「禁止业务代码手工创建 Span」——用 `trace.generation()` 表达 MCP 调用，与 agent tool 调用同一种记录形态，Langfuse 里同样表现为嵌套在 trace 下的子记录。
- Trace 通过可选参数注入，默认 `undefined` → 不创建任何 generation，**零行为变化**，现有测试/调用不受影响。

### 4.3 改动方案（最小改动）

1. **`graph.ts`**：`RunDiagnosisInput` 增加可选 `trace?: ObservabilityTrace`；`run()` 把它传给 `createQueryMonitoringNode(deps)` 生成的 `queryMonitoring` 节点（或直接透传到 monitoringTools）。
2. **`tools/monitoring-tools.ts`**：
   - `DiagnosisMonitoringTools.execute(call, trace?)` 增加可选第二参；
   - `McpDiagnosisMonitoringTools.execute` 内，对每次 MCP 调用包一层：
     ```ts
     const gen = trace?.generation({
       name: "tool-query_trace_log",
       model: "mcp-monitoring",
       input: { traceId },
       metadata: { schemaVersion: MCP_TRACE_SCHEMA_VERSION },
     });
     const result = await monitoringMcpClient.queryTraceLog(traceId);
     gen?.end({
       output: { status: result.status, summary },
       // 可选：把 TraceLog 关键字段（errorCode / spans 数 / conclusion）放入 output
     });
     ```
   - 与 `legacy-agent-runner` 的 `tool-${tc.name}` generation 命名/结构保持一致，便于跨路径对账。
3. **`routes/diagnosis.ts`**：
   - 用 `getObservabilityProvider().createTrace({ name: "diagnosis-service", input: { query } })` 创建 trace；
   - 传给 `diagnosisService.run({ query, kbIds, trace })`，结束后 `trace.end()`；
   - Langfuse 未启用时返回 NoopTrace，`trace?.generation` 为 no-op，无副作用。

**可选增强（不阻塞，按需）：** 知识库检索（`KnowledgeService.searchHybrid`）同样包一个 `generation({ name: "search-knowledge" })`，让「RAG 证据 + 监控数据」在一条诊断 trace 下对齐。评估后决定是否纳入。

### 4.4 测试

- `diagnosis-graph.test.ts` 新增：传 `NoopTrace` 时行为与不传完全一致（回归）；传带 spy 的 `ObservabilityTrace` 时断言 `generation()` 被调用且 `end()` 拿到 output。
- `routes/diagnosis.ts` 无现有测试文件；若加，用 mock provider 断言 trace 创建与传递。
- Path 1 无改动，现有 42 个 teams/modes 测试保持通过。

## 5. 事项 C：文档

- `docs/operations/development.md`：§3 的「监控 MCP Server」小节（启动 / 端口 / 认证 / 验证）。
- （可选）`docs/architecture/` 新增 MCP 监控管线简述：Python server ↔ TS client ↔ 两条诊断路径的数据流，标注生产替换点（仅换 MCP server 实现）。

## 6. 实施清单

| # | 内容 | 类别 |
|---|---|---|
| A1 | `apps/server-py/package.json` 加 `mcp:monitoring` 脚本 | Config |
| A2 | 根 `package.json` 加 `py:mcp` 脚本 | Config |
| A3 | `docs/operations/development.md` 加 MCP server 启动小节 | Docs |
| B1 | `graph.ts`：`RunDiagnosisInput.trace?` + 透传 | 小型功能 |
| B2 | `monitoring-tools.ts`：`execute(call, trace?)` + generation 包裹 | 小型功能 |
| B3 | `routes/diagnosis.ts`：创建 trace + end | 小型功能 |
| B4 | 测试：diagnosis-graph 传 NoopTrace / spyTrace 断言；route（如加） | 测试 |
| C1 | （可选）`docs/architecture/` MCP 监控管线简述 | Docs |

全部可并行推进；B 系列依赖 A（不依赖，独立）。验收：`pnpm py:mcp` 拉起 server 后 `diagnosis.e2e.test.ts` 通过；Langfuse 开启时一次 `POST /api/diagnosis/query` 生成 `diagnosis-service` trace，其下含 `tool-query_trace_log` generation。

## 7. 风险与兼容性

- **低风险**：A 系列纯新增脚本与文档；B 系列 trace 全部可选参数，默认 no-op，不改输出形状与现有签名调用方。
- **接口变更**：`DiagnosisMonitoringTools.execute` 增加可选第二参，唯一实现 `McpDiagnosisMonitoringTools` 同步更新；测试中直接调用 `execute(call)` 的（如 diagnosis.test.ts）不受影响。
- **不引入手工 Span**：符合 `provider.ts` 约束；若未来 RuntimeEvent 落地 span 抽象，可将 generation 平移到 span，形态不变。
- **生产路径无改动**：监控 MCP server 生命周期仍由部署环境负责，TS 不 spawn。

## 8. 已确认决策与剩余问题

**建议决策（默认推进）：**
- ✅ dev 入口用脚本而非 turbo 常驻任务
- ✅ 观测补 Path 2，Path 1 不动
- ✅ 用 `generation()` 而非手工 span

**剩余待确认（影响小）：**
1. 是否把知识库检索也包成 generation（§4.3 可选增强）。
2. 是否新增 `docs/architecture/` 管线简述文档（事项 C 可选）。
3. route 级测试文件是否值得新增（当前 `routes/diagnosis.ts` 无测试）。
