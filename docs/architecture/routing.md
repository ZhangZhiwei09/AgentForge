# AgentForge 路由架构

公共 API、知识库、认证、流程执行和摄取 worker 均由 `apps/server-py` 提供。
两个 React 前端通过现有 SDK 直接调用 Python，运行时不再转发到 TS 后端。

## 入口顺序

1. 安全规则，返回 SAFETY。
2. 明确转人工或取消；人工转接更新会话为 `escalated`，不执行发布流程或模型。
3. 本会话等待中的诊断或任务，沿原快照、预算和审批状态恢复。
4. 已发布一级流程的确定性条件图：固定回复、分流或 continue。
5. 无发布流程时匹配精确问候。
6. 一次业务意图模型分类：consultation、diagnosis 或 unclear。

不明确则澄清，服务失败则明确提示不可用。流程配置缺少明确诊断请求，
或试图通过配置强制转人工时返回配置错误。发布版本与草稿隔离；停用
入口不影响已暂停诊断的原版本续跑。

## 执行关系

```text
POST /api/agent/chat
  -> 会话归属检查 / 消息持久化
  -> decide_entry
     -> 固定回复 / 安全 / 人工
     -> TASK: stream_chat_task -> TaskLifecycle -> build_react_graph
     -> DIAGNOSIS: diagnosis_events -> 已发布或内置诊断流程
  -> SSE + 助手消息 / 引用 / 轨迹 / 等待信息持久化
```

TASK 与 `/api/agent/run`、审批和补充信息 API 共用 ReAct 图与持久化任务生命周期。
知识咨询和工具查询复用混合检索服务，引用使用真实文档、分块 ID，并在输出前
验证引用编号与支持程度。配置诊断也复用现有图和工具注册表；无任务生命周期
的临时诊断图不能执行需要审批的变更工具。

工具调用、回答和诊断可多次请求模型；“一次分类”指入口分类，不限制整个
任务的模型调用次数。每次请求仅有一个助手消息保存方。取消或断连保存已发送
内容，撤销待处理审批；不会重放结果不确定的工具副作用。

## 代码入口

| 路径（`apps/server-py/` 下） | 职责 |
| --- | --- |
| `src/api/v1/chat.py` | 聊天编排、SSE、状态、审计、保存 |
| `src/agent/router/entry_decision.py` | 入口优先级与请求意图守卫 |
| `src/agent/router/business_classifier.py` | 一次业务分类及输出校验 |
| `src/agent/entry_flows/` | 条件 DSL、图验证和确定性执行 |
| `src/services/entry_flows.py` | 草稿、发布、激活和运行记录 |
| `src/services/chat_tasks.py` | 聊天任务与持久化生命周期适配 |
| `src/services/agent_tasks.py` | 任务恢复、审批和预算 |
| `src/agent/react_graph.py` | 共享 ReAct 图 |
| `src/agent/flows/` | 配置式诊断、快照和等待恢复 |
| `src/services/knowledge_retrieval.py` | dense/关键词召回、RRF、去重和重排 |
| `src/api/v1/conversations.py` | 历史分页、会话列表和旧 session 别名 |
| `src/api/deps.py` | 登录身份与兼容匿名聊天 |

保留 SAFETY / CHAT / TASK / HUMAN / DIAGNOSIS 协议标签。
旧五层分类模块和意图样本表作为历史兼容代码/数据保留，不参与企业聊天主入口。
原 TS Runtime、BullMQ、Prisma 客户端和专属包已退役；历史 Prisma SQL 和
workflow/team 表保留，Python 引导会验证已有数据结构。
