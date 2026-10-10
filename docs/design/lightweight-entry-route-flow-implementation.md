# 轻量一级路由流程实施记录

日期：2026-10-10。

## 已实现

管理入口：`/admin/cs/entry-route-flows`，仅管理员可见和访问。接口为 TS 原生 `/api/entry-route-flows`，复用原认证、SDK、React Flow 依赖与管理页面样式。

管理员可以新建空流程或业务模板，添加条件、固定回复、分流、继续节点，连线、拖拽、编辑条件与文案、保存、校验、试运行、发布、启停、归档和查看分页记录。开始节点唯一；图中至少保留一个可达的 continue 终点。配置以连线顺序执行，坐标不影响决策。

试运行使用已保存草稿修订，返回 JSON 决策与节点记录。只写一级运行记录，不调用模型、工具、后续 Router 或真实转人工。正式请求冻结当前发布版本，草稿修改、重发与停用仅影响后续请求。

| 决策 | 主聊天行为 |
| --- | --- |
| reply | 配置正文和建议问题，沿用 meta / token / done / [DONE]；无模型、工具、记忆注入；保存一次助手消息 |
| route | 直接分发 CHAT / TASK / HUMAN / DIAGNOSIS，禁止再次分类；HUMAN 文案传入原会话升级逻辑 |
| continue | 从现有 L2 开始，不再执行旧问候快通道或业务 L1；L2～L5 算法与阈值保持 |

安全规则优先；等待补充的诊断沿用原续跑策略，保留 SAFETY / HUMAN 例外，不读取一级配置。没有启用流程时继续旧入口。一级配置加载或记录写入失败明确返回错误，不静默退回旧规则。

固定回复支持取消和关闭流时保留已输出文本。运行记录描述一级决策是否完成，独立于下游 Agent 是否成功；会话及助手消息 ID 用于关联。已完成决策之后发生下游取消，不会伪装为一级条件计算失败。

## 数据与发布

新增 `entry_route_flows` 和 `entry_route_flow_runs` 两张独立表，不复用诊断或通用 Workflow 表。JSONB 保存草稿、发布快照和有界记录；运行摘要及记录对常见密钥、令牌、邮箱和手机号脱敏，不保存认证头或会话历史。

草稿允许断开的图；字段及大小边界仍校验，试运行与发布执行完整图校验。保存、校验、发布和试运行要求当前修订号，过期返回 409。发布锁定目标记录；启用切换采用事务和全局 advisory lock，部分唯一索引约束全平台至多一个启用流程。未发布或已归档流程不能启用。创建模板不自动启用，归档保留运行历史。

迁移：`packages/database/prisma/migrations/20261010120000_add_entry_route_flows/migration.sql`。

开发库已定向应用该 SQL，并使用 `prisma migrate resolve --applied 20261010120000_add_entry_route_flows` 登记。没有运行整条待部署迁移链，未执行尚未应用的 `20261007120000_drop_app_generation_tables`。

限制：30 节点、60 连线、每条件至多 50 个匹配词及 50 个排除词、每词 128 字符、正文 8000 字符、5 条建议且每条 200 字符、消息 16000 字符。运行摘要最多 2000 字符，错误最多 1000 字符，每页最多 50 条运行。无脚本、自由正则、模型节点、工具节点、循环、并行或子流程。

## 模板差异

默认模板按问候、感谢、告别、人工、诊断、continue 顺序配置。问候等使用精确匹配和限定末尾标点规范化；人工与诊断使用任意包含。模板可编辑，未声称与原正则完全等价。

| 示例 | 差异 |
| --- | --- |
| HI / HELLO | 新模板忽略大小写，可获得固定回复；原问候正则区分大小写 |
| 你好！ / 谢谢。 | 保持固定回复基线 |
| 你好？ | 问号不在原问候标点集合，新模板也不移除，进入 continue |
| 找你们经理 / 叫负责人 / 投诉你们服务 | 原正则可命中 HUMAN；模板尚未包含所有变体，进入后续路由 |
| traceId : abc / error code: ABC | 模板不等价转换可变空格正则；其他故障词未命中时进入 continue |
| 成功率下降 | 原诊断正则可命中；初始词表未完整覆盖，可由管理员增加关键词 |
| 转人工并且失败 | 人工条件先于诊断条件；安全命中仍先于二者 |

原关键词与固定回复未删除，停用可恢复；continue 保留 L5 售后联系到 HUMAN 的原兜底，不能假设未命中一级就绝不会转人工。

## 验证记录

- 编码前重点路由、安全、人工与诊断桥接基线：736 项通过。
- 最新 TS 新增及重点路由回归：899 项通过；数据库专属 6 项另用隔离数据库全部通过。
- 数据库测试验证并发保存、修订冲突、全局唯一启用、发布快照、停用、归档保留、记录归属与分页。脚本创建并移除本次专属测试库，不切换业务库的入口绑定。
- TS 服务、管理端、客服端类型检查及管理端生产构建通过；Prisma validate 和 generate 通过。构建仍有既有的大于 500 KB bundle 提示。
- 新增一级流程浏览器验收：7 项通过，包括真实鼠标连线、图错误定位、保存后重新进入页面、普通用户权限、配置回复、真实 HUMAN 会话升级、停用回退及桌面/窄屏拖拽稳定性。
- 真实模型浏览器验收覆盖 DIAGNOSIS 进入 Python 流程并等待补充，客服端显示补充卡片；等待期间发布及停用一级流程后，发送“你好”仍续跑原诊断版本并保留已完成专家记录。空一级流程下“你好”继续进入 L2～L5，并收到真实模型回复。
- 原管理端流程浏览器回归：12 项通过，1 项可选模型测试未在该命令执行。原账号切换和退出：7 项通过，1 项可选真实账号测试跳过。
- Python 流程、PostgreSQL checkpoint/HITL 集成、启动配置、连接错误及原执行器相关回归：62 项通过。

全量服务端检查的首次结果是 2855 项通过、39 项失败、7 项跳过，包含旧认证测试数据库凭据、旧 Agent mock、知识库去重、工具 mock 和时间格式断言问题。将 11 个失败文件在改动前 `0eb1700` 独立工作树与当前代码对照运行，双方稳定失败均为 38 项，失败用例一致；余下 1 项取消计时用例复跑通过。未修改这些无关模块以掩盖原失败。

浏览器截图位于系统临时目录 `agent-flow-playwright`。新增测试对每个场景使用独立的现有限流 key，避免一组验收请求占满每分钟 60 次的开发配额；没有修改业务限流设置。测试新建独立账号与流程，结束后恢复原绑定并清理本次记录。

真实模型验收使用临时诊断流程，禁用该测试流程的外部工具，并要求返回缺失字段以验证补充链路。这证明入口分流与续跑可用，不代表监控日志分析能力或诊断质量已经通过评测。

## 验证入口

```powershell
pnpm --filter @agentforge/server typecheck
pnpm --filter @agentforge/data-admin build
pnpm --filter @agentforge/customer-service typecheck
pnpm --filter @agentforge/database exec prisma validate
pnpm --filter @agentforge/server test:entry-flows:db
$env:AGENT_FLOW_ADMIN_URL = 'http://localhost:5200'
pnpm --filter @agentforge/data-admin test:e2e:entry-flows
```

真实配置模型验收：

```powershell
$env:AGENT_FLOW_ADMIN_URL = 'http://localhost:5200'
$env:AGENT_ENTRY_FLOW_LIVE_MODEL = '1'
pnpm --filter @agentforge/data-admin test:e2e:entry-flows
```

该模式临时切换一级与诊断全局绑定，只在隔离开发环境使用。要求 Python 后端启用已有 HITL 能力，使用当前配置模型，无需新增模型或观测平台服务。

## 回滚与运行

开发入口：管理端 `http://localhost:5200/admin/cs/entry-route-flows`，客服端 `http://localhost:5173`；TS 8000、Python 8004、PostgreSQL 5434、Redis 6379。

验收结束后已清理本次测试账号、一级流程和运行记录，隔离测试库已删除；原诊断流程 `85684485-40fd-41ed-9bea-56047b6c4ca0` 保持版本 2 启用，原有等待补充任务保留。没有自动创建或启用一级流程，管理员可从空流程或业务模板开始配置。

正常回滚是在管理端停用一级流程；后续请求恢复原入口，当前请求仍用所选快照，原诊断绑定及待补充任务保留。无需删除新表、历史或代码。

管理页不可用时，数据库管理员可只停用一级绑定：

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('entry_route_flows_activation'));
UPDATE entry_route_flows
SET enabled = false, updated_at = CURRENT_TIMESTAMP
WHERE enabled = true;
COMMIT;
```

此操作不改 `agent_flows` / `agent_flow_runs`。没有新增公开紧急端点。进程崩溃留下的 running 记录不支持自动恢复。
