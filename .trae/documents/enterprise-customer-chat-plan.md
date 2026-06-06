# 企业级智能客服 - 渐进式演进方案

## 一、当前状态分析

### 1.1 已有能力
- **前端**：`CustomerChat` 组件（浮动气泡 + 聊天窗口），支持 SSE 流式接收，打字动画，AbortController 取消
- **后端 API**：`POST /api/customer-chat`，SSE 流式返回
- **后端 Service**：`CustomerChatService`，调用 provider 流式聊天
- **基础设施**：Provider Registry（OpenAI / DeepSeek）、Milvus 向量数据库、Memory Engine、PostgreSQL + SQLAlchemy Async

### 1.2 当前缺陷
- **无上下文记忆**：每次请求是独立的，不携带历史对话
- **无会话管理**：没有 session/conversation 概念
- **无知识库**：system prompt 是固定的一句话，没有业务知识支撑
- **无意图识别**：所有问题用同一个策略回复
- **无人工转接**：无法处理 AI 解决不了的问题
- **无数据持久化**：客服对话不存储，无法追溯和分析
- **无质量评估**：没有满意度评价、没有指标统计

### 1.3 相关文件清单
| 文件 | 作用 |
|---|---|
| `apps/web/src/components/customer-chat/CustomerChat.tsx` | 前端客服聊天组件 |
| `apps/api/app/services/customer_chat_service.py` | 后端客服服务（当前无状态） |
| `apps/api/app/routers/customer_chat.py` | 后端路由 |
| `apps/api/app/schemas/customer_chat.py` | 请求 Schema |
| `apps/api/app/services/chat_service.py` | 参考：已有完整的多轮对话 + 记忆注入 |
| `apps/api/app/services/memory_engine.py` | 参考：Milvus 向量搜索 + 记忆提取 |
| `apps/api/app/models/conversation.py` | 参考：会话模型 |
| `apps/api/app/models/message.py` | 参考：消息模型 |
| `apps/web/src/components/layout/ChatLayout.tsx` | 客服组件挂载位置 |

---

## 二、Phase 1：多轮对话上下文

**目标**：客服能记住同一会话中的对话历史，支持连续对话。

### 2.1 数据模型

**方案选择**：不新建表，复用现有 `conversations` + `messages` 表。

- 新增一个特殊 `user_id`（如 `00000000-0000-0000-0000-000000000002`）作为"客服匿名用户"
- 每条消息关联 `conversation_id` + 复用的 `messages` 表
- `conversations.title` 固定为 `"客服会话-{session_id}"`
- 考虑在消息表增加 `session_id` 字段区分客服对话和普通对话

> **决定**：采用独立 `session_id` 字段方案（通过 `conversations` 表的类型字段区分），避免与主聊天系统耦合太紧。

**实际方案**：在 `conversations` 表增加 `type` 字段（默认 `"chat"`，客服会话为 `"customer_service"`），新增 `session_id`（前端传入的匿名会话标识）字段。

### 2.2 后端改动

#### 文件：`apps/api/app/models/conversation.py`
- 新增 `type` 字段：`Mapped[str] = mapped_column(String(32), default="chat")`
- 新增 `session_id` 字段（可选）：`Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)`

#### 文件：`apps/api/app/schemas/customer_chat.py`
- 扩展 `CustomerChatRequest`：
  - `session_id: str | None = None` — 前端传入的会话标识
  - `message: str = Field(..., min_length=1)` — 保持不变

#### 文件：`apps/api/app/services/customer_chat_service.py`
- 改造为依赖 `AsyncSession`（通过依赖注入或构造函数传入）
- 新增 `_get_or_create_conversation(session_id)` 方法：
  - 有 `session_id` 时从 DB 查找已有会话
  - 没有则创建新会话，返回 `conversation_id`
- 改造 `stream_chat`：
  - 接受 `session_id` 参数
  - 加载历史消息（最近 20 条）
  - 保存用户消息到 DB
  - 流式返回 + 流式结束后保存 assistant 消息到 DB
  - 参考 `ChatService.stream_chat()` 的完整流程

#### 文件：`apps/api/app/routers/customer_chat.py`
- 注入 `db: AsyncSession = Depends(get_db)`
- 传递 `session_id` 给 Service
- 返回 `session_id` 给前端（首次创建时，通过首个 meta chunk）

### 2.3 前端改动

#### 文件：`apps/web/src/components/customer-chat/CustomerChat.tsx`
- 新增 `sessionId` 状态：从 `localStorage` 读取（key: `customer_chat_session_id`）
- 首次进入时生成 UUID（通过 `crypto.randomUUID()`）
- `handleSend` 请求 body 增加 `session_id`
- 解析首个 `meta` chunk 获取 `session_id`（服务端确认），存入 `localStorage`
- 新增"清空对话"按钮（重置 session_id，重新开始）

### 2.4 数据库迁移
- Alembic 迁移脚本：为 `conversations` 表增加 `type` 和 `session_id` 列
- 为默认客服用户 seed 数据

### 2.5 验证步骤
1. 打开前端，发送第一条消息 → 收到回复
2. 发送第二条消息（引用第一条的内容，如"你刚才说的那个..."） → 客服能理解上下文
3. 刷新页面 → 对话历史恢复（因为 session_id 保存在 localStorage）
4. 点击清空对话 → 新 session_id 生成 → 历史清空

---

## 三、Phase 2：知识库（RAG）

**目标**：客服能基于公司/产品知识库给出准确回答，而非凭空编造。

### 3.1 数据模型

#### 文件：`apps/api/app/models/knowledge.py`（新建）
```python
class KnowledgeBaseModel(Base):
    __tablename__ = "knowledge_bases"
    id: str (PK, UUID)
    name: str (知识库名称，如"产品FAQ")
    description: str | None
    created_at: datetime

class KnowledgeDocumentModel(Base):
    __tablename__ = "knowledge_documents"
    id: str (PK, UUID)
    knowledge_base_id: str (FK)
    title: str
    content: text
    embedding_id: int | None (Milvus 向量 ID)
    enabled: bool (默认 True)
    created_at: datetime
    updated_at: datetime
```

- 复用现有 Milvus 基础设施（或新建 `agentforge_knowledge` collection）
- 文档分块：长文档按段落/语义拆分存储，每块独立向量化

### 3.2 后端改动

#### 文件：`apps/api/app/services/knowledge_service.py`（新建）
- `search(query: str, top_k: int = 3) -> list[KnowledgeSearchResult]`
  - 向量化查询文本
  - 在 Milvus 中搜索相似文档块
  - 返回 top_k 个最相关片段

#### 文件：`apps/api/app/services/knowledge_ingestion.py`（新建）
- `ingest_document(doc_id, content)` — 分块 + 向量化 + 存储
- `ingest_faq(faq_list)` — 批量导入 FAQ

#### 文件：`apps/api/app/services/customer_chat_service.py`
- 在 `stream_chat` 中调用 `knowledge_service.search(user_message, top_k=3)`
- 将检索结果拼入 system prompt：
  ```
  # 相关知识库信息
  以下是可能对回答有帮助的参考信息，请基于这些信息回答用户问题：

  【参考1】...
  【参考2】...
  ```

#### 文件：`apps/api/app/routers/knowledge.py`（新建）
- `GET /api/knowledge-bases` — 列出知识库
- `POST /api/knowledge-bases/{id}/documents` — 添加文档
- `DELETE /api/knowledge-bases/{id}/documents/{doc_id}` — 删除文档

### 3.3 前端改动

暂不需要改动（知识库内容由后端管理，前端客服界面自动受益）。

### 3.4 初始数据
- 提供预置的 AgentForge 产品 FAQ 数据脚本
- 种子数据包含：产品介绍、功能说明、定价、技术支持等常见问题

### 3.5 验证步骤
1. 导入 FAQ 数据
2. 在前端客服询问"AgentForge 是什么？" → 回答基于知识库内容
3. 询问知识库未覆盖的问题 → 不编造，礼貌引导

---

## 四、Phase 3：意图识别与分流

**目标**：识别用户意图，不同意图走不同处理策略。

### 4.1 意图分类

| 意图 | 标识 | 处理策略 |
|---|---|---|
| 产品咨询 | `product_inquiry` | 启用知识库检索 |
| 技术问题 | `technical_support` | 启用知识库 + 详细排查步骤 |
| 投诉建议 | `complaint` | 安抚情绪 + 记录 + 标记优先级 |
| 购买意向 | `sales_inquiry` | 引导转化 + 提供联系方式 |
| 转人工请求 | `human_handoff` | 触发转人工流程 |
| 闲聊 | `chitchat` | 友好回应 + 引导回正题 |

### 4.2 后端改动

#### 文件：`apps/api/app/services/intent_classifier.py`（新建）
- `classify(message: str, history: list) -> IntentResult`
- 使用 LLM 做意图分类（少样本 prompt）
- 返回 `{"intent": "product_inquiry", "confidence": 0.95, "entities": {...}}`

#### 文件：`apps/api/app/services/customer_chat_service.py`
- 在 `stream_chat` 开头调用意图分类
- 根据意图选择不同的 system prompt 模板
- 不同意图可选用不同的处理分支：
  - `product_inquiry` → 强制 RAG 检索
  - `complaint` → 添加安抚性 prompt
  - `human_handoff` → 不调 LLM，直接返回转接提示

### 4.3 设计决策
- 意图分类用**轻量 prompt + 小模型**（如 `gpt-4o-mini`），减少延迟
- 意图置信度低于 0.6 时降级为 `product_inquiry`（默认策略）
- 投诉类意图自动记录日志，便于后续分析

### 4.4 验证步骤
1. 问"我想买你们的产品" → 触发 `sales_inquiry` 意图
2. 问"你们这个功能怎么用" → 触发 `product_inquiry` 意图
3. 说"我要投诉" → 触发 `complaint` 意图
4. 闲聊"今天天气不错" → 触发 `chitchat` 意图

---

## 五、Phase 4：人工转接

**目标**：AI 无法处理的问题，无缝转接给人工客服。

### 5.1 数据模型

#### 文件：`apps/api/app/models/support_ticket.py`（新建）
```python
class SupportTicketModel(Base):
    __tablename__ = "support_tickets"
    id: str (PK, UUID)
    conversation_id: str (FK -> conversations.id)
    session_id: str
    status: str (enum: "pending"/"assigned"/"resolved"/"closed")
    priority: str (enum: "low"/"medium"/"high"/"urgent")
    customer_message: text (触发转接的消息)
    ai_summary: text (AI 对问题的总结)
    agent_id: str | None
    resolution: text | None
    created_at: datetime
    updated_at: datetime
```

### 5.2 触发条件
1. **用户主动请求** → 输入包含"转人工""人工客服""真人"等关键词
2. **意图识别为 `human_handoff`** → 直接触发
3. **AI 连续 3 轮无法回答** → 自动建议转人工
4. **敏感话题** → 投诉类自动建议转人工

### 5.3 后端改动

#### 文件：`apps/api/app/services/handoff_service.py`（新建）
- `should_handoff(history, intent) -> bool` — 判断是否应该转人工
- `create_ticket(...) -> SupportTicket` — 创建工单
- `summarize_for_agent(messages) -> str` — 用 LLM 总结对话要点

#### 文件：`apps/api/app/services/customer_chat_service.py`
- 每轮对话前检查 `should_handoff`
- 触发转接时：生成 AI 总结 → 创建工单 → 返回转接提示

#### 文件：`apps/api/app/routers/customer_chat.py`
- SSE chunk 新增 `type: "handoff"` 类型，携带工单号

### 5.4 前端改动

#### 文件：`apps/web/src/components/customer-chat/CustomerChat.tsx`
- 解析 `handoff` chunk → 替换输入区域为"已转接人工"提示
- 显示工单号供用户参考
- 保持聊天窗口可用（后续人工回复也通过这个窗口？还是走邮件/电话？）

### 5.5 简化方案
Phase 4 暂不做完整工单系统。MVP 方案：
- 触发转接时，AI 回复"已为您记录，客服专员将在 24 小时内通过邮件联系您"
- 后端创建工单 + 记录，但不建立实时人工客服界面
- 后续可扩展为 WebSocket 实时人工聊天

### 5.6 验证步骤
1. 输入"转人工" → 触发转接流程
2. 连续 3 次问无法回答的问题 → 自动建议转人工

---

## 六、Phase 5：分析与质量

**目标**：评估客服质量，持续优化。

### 6.1 数据模型

#### 文件：`apps/api/app/models/customer_feedback.py`（新建）
```python
class CustomerFeedbackModel(Base):
    __tablename__ = "customer_feedbacks"
    id: str (PK, UUID)
    conversation_id: str (FK)
    message_id: str (FK) (被评价的 assistant 消息)
    rating: str (enum: "positive"/"negative")
    comment: text | None
    created_at: datetime
```

#### 文件：`apps/api/app/models/chat_metrics.py`（新建）
```python
class ChatMetricsModel(Base):
    __tablename__ = "chat_metrics"
    id: str (PK, UUID)
    conversation_id: str (FK)
    session_id: str
    intent: str | None
    response_time_ms: int
    first_token_ms: int
    token_count: int
    handoff_triggered: bool
    resolved: bool (对话是否有效解决)
    created_at: datetime
```

### 6.2 后端改动

#### 文件：`apps/api/app/routers/feedback.py`（新建）
- `POST /api/customer-chat/feedback` — 提交满意度评价
- `GET /api/customer-chat/metrics` — 获取统计数据（管理员）

#### 文件：`apps/api/app/services/metrics_service.py`（新建）
- 每次对话结束时记录指标
- 聚合统计：响应时间、解决率、转人工率、满意度

#### 文件：`apps/api/app/services/customer_chat_service.py`
- 流式结束时记录 `ChatMetrics`

### 6.3 前端改动

#### 文件：`apps/web/src/components/customer-chat/CustomerChat.tsx`
- 每条 assistant 消息后显示  👍 / 👎 按钮
- 点击后发送反馈到后端
- 简单的反馈动效

### 6.4 验证步骤
1. 完成一轮对话 → 点击 👍 → 后端收到反馈
2. 查看指标接口 → 返回统计数据

---

## 七、Phase 6：生产加固

**目标**：安全、稳定、高性能。

### 7.1 速率限制

#### 文件：`apps/api/app/middleware/rate_limit.py`（新建）
- 基于 IP 或 session_id 的简单限流
- 每 60 秒最多 30 次请求（可配置）
- 超出返回 429 Too Many Requests

### 7.2 输入校验与安全

#### 文件：`apps/api/app/middleware/content_filter.py`（新建）
- 敏感词过滤（注入攻击、恶意内容检测）
- 消息长度限制（最大 2000 字符）
- 输入消毒（HTML/XSS 过滤）

### 7.3 降级策略

#### 文件：`apps/api/app/services/customer_chat_service.py`
- LLM 不可用时 → 返回预设的兜底文案
- Milvus 不可用时 → 降级为纯 LLM（不带知识库）
- 超时兜底 → 30 秒未收到首 token 时返回预设回复

### 7.4 缓存

#### 文件：`apps/api/app/services/cache_service.py`（新建）
- 使用内存缓存（LRU）缓存热门 FAQ 的向量搜索结果
- TTL 5 分钟，最多 100 条

### 7.5 日志审计

- 所有对话记录到 `chat_metrics` 表
- 敏感操作（转人工、投诉）额外记录
- 结构化日志输出（JSON 格式）

### 7.6 验证步骤
1. 快速连续发送 31 次请求 → 返回 429
2. 发送超长消息 → 返回 422 校验错误
3. 停掉 LLM 服务后发送消息 → 返回兜底回复
4. 检查日志 → 所有请求有迹可循

---

## 八、实施依赖与风险

| Phase | 依赖项 | 风险 | 缓解 |
|---|---|---|---|
| 1 | 现有 DB + Alembic | 迁移冲突 | 先验证现有迁移状态 |
| 2 | Milvus 运行正常 | Milvus 不可用 | 降级为无 RAG 模式 |
| 3 | LLM 额外调用（意图分类） | 延迟增加 ~500ms | 用轻量 prompt + 小模型 |
| 4 | 无外部依赖 | — | — |
| 5 | Phase 1 完成 | — | — |
| 6 | 所有 Phase 完成 | 过度工程化 | 按需裁剪 |

---

## 九、时间线建议

建议按 Phase 顺序渐进实施，每个 Phase 完成后验证再进入下一阶段：

```
Phase 1 (多轮对话) → Phase 2 (知识库) → Phase 3 (意图识别)
                                            ↓
Phase 6 (生产加固) ← Phase 5 (质量分析) ← Phase 4 (人工转接)
```

其中 Phase 1-3 是核心能力，Phase 4-6 可根据业务需求调整优先级。
