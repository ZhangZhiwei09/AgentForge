# 轻量 Agent 流程首版

日期：2026-10-07。范围以 `lightweight-agent-flow-plan.md` 为准。

## 交付范围

- 管理端增加 Agent 流程列表和 React Flow 编辑画布。
- 开始、Agent、条件、结束四类节点；串行执行和互斥分支。
- 节点内配置角色名称、职责、系统提示词、任务、输入映射、输出字段、已有工具和执行限制。
- 配置节点只接收 ReAct 最终回答，不拼接工具调用前的中间文本；工具失败、未完成的预算截断和无最终回答均终止节点。其他路由保持原有执行器默认行为。
- 保存草稿、修订冲突检查、试运行 SSE、节点输入输出记录、发布、唯一启用绑定及归档。
- 前端排查、后端排查、综合分析的业务契约和强制升级规则仍由后端保护。
- 可以在后端与汇总之间插入新专家，不需要修改编排代码。
- 正式聊天使用启用版本；没有启用流程时继续使用原有诊断团队。运行失败不会自动重跑旧团队。
- 客服事件和诊断卡片支持动态节点；未走到的分支标为跳过。
- 运行持有完整配置快照；发布、停用、改名不影响旧运行或等待补充的续跑。

没有加入循环、并行、代码节点、插件市场、独立角色库、调度服务或第二套 TS 配置执行引擎。

## 接入方式

```text
管理端 -> TS /api/agent-flows -> Python 管理 API
客服 /api/agent/chat -> TS 原有意图路由
  普通问答/其他任务 -> 原有实现
  DIAGNOSIS
    无启用配置且无待续跑记录 -> 原有 TS 诊断团队
    启用配置或等待补充 -> HMAC 签名桥接 -> Python 配置 LangGraph
```

TS 管理转发和 Python API 均校验管理员权限。内部运行端点不通过管理代理公开，验签包含时间戳、请求路径和原始请求体。对外只发送诊断摘要，不发送节点完整输入。

正式聊天拒绝签名无效的登录令牌，并检查会话归属。匿名聊天沿用原有系统用户身份；首版没有重新设计匿名访客会话授权。

## 本地启动

前提：PostgreSQL、Redis 可用，Node/pnpm 和 Python/uv 已安装，已有模型配置可用。

```powershell
pnpm install
pnpm dev:agent-flows
```

启动器读取 `apps/server/.env`，统一业务数据库和 JWT 密钥，不覆盖任何 `.env` 文件。当前平台默认使用 DeepSeek 时，将其配置映射到 Python 已有的 OpenAI 兼容 Provider。

常规 `pnpm dev` 也会通过 `python -m src.dev` 启动 Python 平台后端，读取 TS 的数据库和 JWT 配置（显式环境变量优先），不再误用独立的 `agentforge_py` 库。此启动方式不改写两端 `.env`，Python 独立启动 `python -m src.main` 仍使用自己的配置。更新启动命令后，需要重启开发服务。

启动器默认选择 Python `8005`、TS `8001`、管理端 `5201`；端口已占用时使用其他空闲端口。实际地址打印在终端。

默认管理入口：

```text
http://localhost:5201/admin/cs/agent-flows
```

默认普通用户账号没有流程管理权限。新开发库可单独创建管理员：

```powershell
pnpm --filter @agentforge/server exec node scripts/create-admin.mjs
```

账号默认是 `admin@agentforge.local`；密码随机生成，仅在命令输出中显示，不写入前端或种子文件。可通过 `ADMIN_EMAIL`、`ADMIN_PASSWORD` 环境变量指定账号及至少 12 字符的密码。已有同名账号时命令拒绝覆盖，不会自动提权或重置密码。

普通用户可点击面板顶栏的“管理员登录”入口，退出当前会话并进入管理员表单；输入密码验证角色后返回原管理页面。登录页也提供普通用户与管理员身份切换。切换不绕过两套后端的权限检查，也不保留前一个账号的查询缓存。

本地开发可在 `apps/data-admin/.env.local` 设置 `VITE_DEV_ADMIN_PASSWORD`，管理员表单将预填密码并保持掩码显示。该文件被 Git 忽略，不要提交真实密码。此选项仅在开发模式启用，生产构建始终为空；预填凭据会发送给开发浏览器，因此不要把开发服务公开给不可信网络。

使用管理员账号登录后新建诊断流程。选择后端节点，再添加 Agent，可自动插入专家并映射其输出到汇总节点。

启动器保留现有服务，不使用 Python 自动重载；修改 Python 后需重启该启动器。停止时只清理它自己的子进程。

如果不使用启动器：

- TS 的 `AGENT_FLOW_BACKEND_URL` 指向 Python 服务，缺省为 `http://127.0.0.1:8004`。
- 两套后端的 `DATABASE_URL` 必须指向同一业务库，Python 使用 `postgresql+asyncpg://`。
- 两套后端的 `JWT_SECRET` 必须相同。
- Python 的模型名称、兼容 API 地址和凭据需与当前正式诊断模型匹配。首版没有扩展 Python 的多 Provider 管理。
- 管理端的 `AGENTFORGE_API_URL` 可以改变开发代理目标，默认仍为原有 `8000`。
- 客服页面默认仍代理 `8000`；独立工作台的正式链路测试使用 `8001` 的 `/api/agent/chat`。不要误把旧服务上的请求当成新实例的验证。

若 TS 登录成功、`/api/auth/me` 正常，但流程接口提示后端认证失败，应检查 Python 的数据库和 JWT 配置。TS 已验证通过的登录不会因为 Python 返回 401 被清除；管理代理将其报告为 502 配置错误。真正的 TS 登录失效仍返回 401 并要求重新登录。

## 数据库

仅增加 `agent_flows` 和 `agent_flow_runs` 两张业务表。节点、角色和版本快照保存在 JSONB 中，未建立独立节点库或版本库。

新增迁移：

```text
packages/database/prisma/migrations/20261007160000_add_agent_flows/migration.sql
```

当前本地 `agentforge` 库已单独应用并登记该迁移，不要重复执行建表 SQL。仓库另有待应用的 `20261007120000_drop_app_generation_tables`，本次未执行，不能为本功能未经检查直接部署全部迁移。

对尚未应用的新开发库，在核对迁移状态后可单独执行：

```powershell
pnpm --filter @agentforge/database exec prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261007160000_add_agent_flows/migration.sql
pnpm --filter @agentforge/database exec prisma migrate resolve --applied 20261007160000_add_agent_flows
pnpm db:generate
```

Prisma schema 校验通过。本地生成客户端曾因现有服务锁定 Windows 引擎 DLL 而失败；停止持有该 DLL 的服务后再运行 `pnpm db:generate`。新流程的 TS 桥接使用参数化原生查询，不依赖新客户端模型 API，当前页面和执行链路已验证。

## 等待补充

Python 配置项：

```text
LANGGRAPH_DIAGNOSIS_CHECKPOINT_ENABLED=true
LANGGRAPH_DIAGNOSIS_HITL_ENABLED=true
```

可以在启动工作台前设置环境变量：

```powershell
$env:LANGGRAPH_DIAGNOSIS_HITL_ENABLED = 'true'
pnpm dev:agent-flows
```

等待记录和运行快照保存在业务库，checkpoint 使用现有 PostgreSQL Saver。恢复时按旧运行 ID 读取，不重新执行已完成 Agent。

首版沿用现有补充语义：补充后继续结束节点，附加 `user_supplement`；不会自动让各专家重新分析补充内容。任意运行中崩溃恢复、重试副作用工具和自动清理失联运行不在本版范围内。进程崩溃可能留下 `running` 记录，需要运营侧核查，不应当成成功任务。

## 验证命令

无模型单元测试：

```powershell
cd apps/server-py
uv run pytest tests/agent/flows -q
```

真实 PostgreSQL 集成测试：

```powershell
$env:DATABASE_URL = 'postgresql+asyncpg://postgres:postgres@127.0.0.1:5434/agentforge'
$env:AGENT_FLOW_INTEGRATION = '1'
uv run pytest tests/agent/flows -q
```

共 37 项通过，集成测试验证管理员权限、修订冲突、新专家插入、发布、试运行记录、并发领取、取消、桥接验签以及发布新版并停用后恢复旧版。使用真实 PostgreSQL Saver，新建 Saver 实例后仍能续跑。

同时运行原有执行器和 ReAct 回归，合计 52 项通过：

```powershell
uv run pytest tests/agent/flows tests/test_agent.py tests/agent/test_react_graph.py -q
```

TS 回归：

```powershell
pnpm --filter @agentforge/server exec vitest run src/routes/__tests__/agent-runtime-access.test.ts src/services/agent-runtime/__tests__/configured-diagnosis.test.ts src/teams/__tests__/schema.test.ts src/teams/modes/__tests__/diagnosis.test.ts src/services/agent-runtime/__tests__/chat-agent.test.ts
```

已通过 212 项测试，包含会话权限、SSE 分片、UTF-8、签名、取消信号、截断流和禁止失败后回退。

管理端浏览器回归，先启动工作台：

```powershell
pnpm --filter @agentforge/data-admin exec playwright install chromium
pnpm --filter @agentforge/data-admin test:e2e:flows
```

额外调用已配置模型：

```powershell
$env:AGENT_FLOW_LIVE_MODEL = '1'
pnpm --filter @agentforge/data-admin test:e2e:flows
```

测试创建独立测试账号和流程，完成后删除自身记录并恢复测试前的启用绑定。测试会短暂切换诊断绑定，仅在隔离的开发环境执行。截图保存到系统临时目录 `agent-flow-playwright`。

桌面 `1440x960` 和手机 `390x844` 已验证新增专家、编辑、发布、启用、草稿隔离及无横向溢出。真实模型已通过四 Agent 试运行和正式聊天 API，监控 MCP 服务当前不可用，真实模型验证使用零工具，不代表监控排查效果达标。

页面试运行已验证 SSE 状态、专家节点输入输出、画布视口和插入节点不重叠。真实 HITL 链路已验证等待提示与动态阶段写入聊天历史，以及通过正式聊天入口补充后完成续跑。尚未完成任意复杂图的手动连线浏览器矩阵和旧诊断卡片全量回归，未把这些缺口标为通过。

TS 服务、管理端、客服端类型检查和管理端生产构建已通过。构建仍有大于 500 KB 的 bundle 提示，未为本功能扩大到全站拆包重构。

原有 Python 诊断回归另有 3 项失败：`test_fast_track`、`test_stage_timeout_retry_once`、`test_role_timeout_override`。现有强制升级行为与旧测试默认错误码问题不一致，本次未修改该部分用户代码或掩盖失败。
