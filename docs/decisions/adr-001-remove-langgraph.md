# ADR-001: 移除 LangGraph，回归自研 Agent Runtime

**状态：** 已采纳
**日期：** 2026-07-12
**决策者：** AgentForge 团队

---

## 背景

项目在 Phase 1 引入了 `@langchain/langgraph` 作为并行 Agent 执行引擎的候选方案。引入时规划了分阶段迁移路径（Phase 0→1→2→3→4），并在 `agent/runner/` 和 `agent/langchain/` 下搭建了 9 个适配器骨架文件，预留了 `AgentEngine = "legacy" | "langgraph"` 双引擎类型。

经过 3 个月的验证和评估，决定不继续推进 LangGraph 迁移。

---

## 决策

**移除 `@langchain/langgraph` 和 `@langchain/core` 依赖，核心 Agent 循环保持自研。**

具体执行：
- 删除 `@langchain/langgraph` 和 `@langchain/core` 依赖
- 删除 5 个 `agent/langchain/` 骨架文件（所有方法返回 null/throw）
- 删除 3 个 `agent/runner/` 引擎选择相关文件（checkpoint-adapter、runner-selector、session-engine-state）
- 清理 `AgentEngine` 类型和所有 LangGraph 相关注释
- 将 Diagnosis Service 的 StateGraph 改写为纯 async 函数
- 归档 LangGraph 迁移设计文档

---

## 理由

### 1. 当前唯一的 LangGraph 使用点未用到框架核心价值

Diagnosis Service（`diagnosis/graph.ts`）是项目中唯一实际使用 `StateGraph` 的模块。但其 10 个节点全部是纯规则逻辑：零 LLM 调用、无 ReAct 循环、无中断/恢复、无人在回路、无 Checkpoint 持久化。该图本质上是 5 个 async 函数 + 2 个 if-else，StateGraph 包装未提供增量价值。

这一判断与项目自身的设计文档一致（`docs/design/diagnosis-service-improvement-plan.md`）。

### 2. 核心 Agent Runner 已稳定且功能完整

`LegacyAgentRunner`（~1900 行）实现了完整的 ReAct 循环、Human-in-the-Loop、工具调用、流式输出和多 Provider 路由。所有关键路径已生产验证。替换为 LangGraph 的边际收益远低于成本。

### 3. 保持 Provider-agnostic 是架构优势

AgentForge 的核心竞争力之一是支持多 LLM Provider（Claude、OpenAI、DeepSeek 等）。LangGraphAgentRunner 即使实现，也会面临 Provider 兼容性问题——LangGraph 本身不解决多 Provider 路由，而当前的 ProviderRouter 已成熟可用。

### 4. 减少维护负担

移除后消除：
- 2 个 npm 依赖（安全和版本升级不再影响本项目）
- 9 个骨架文件（CI typecheck、ESLint、新成员认知成本）
- 1697 行迁移设计文档（不再需要与代码同步维护）

---

## 后果

### 正面
- 代码库更简洁，新成员认知负担降低
- 依赖链缩短，安全审计面减少
- Agent 架构方向明确：自研 Runtime 是唯一执行路径

### 需关注
- **持久化 Checkpoint 能力空白**：当前 Agent Session 宕机后无法恢复。这是需要自研的下一个能力，但属于独立需求，不需要 LangGraph 作为前置条件。
- **如果未来 Agent 复杂度需要图编排**（嵌套子图、分布式 Checkpoint、多 Agent 协作的复杂状态管理），可以重新评估。但评估标准是"解决什么具体问题"，不是"用了什么框架"。

---

## 备选方案

| 方案 | 评估 |
|---|---|
| A. 只将 LangGraph 用于 Checkpoint + Resume | 可行但引入框架仅为一个特性，性价比低 |
| B. 彻底移除（当前决策） | 简洁，代价低，未来需要时再评估 |
| C. 保持现状不做变动 | 持续积累技术债，不推荐 |

---

## 参考

- `docs/design/langchain-langgraph-refactor-plan.md`（已归档）
- `docs/design/diagnosis-service-improvement-plan.md`
