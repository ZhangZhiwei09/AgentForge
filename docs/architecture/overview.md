# Architecture Overview

AgentForge is a **pnpm + Turborepo monorepo** building a progressive AI agent platform. The roadmap spans platform engineering (P0-P2) and agent capability phases (V5-V9, V11). Completed phases are marked with ✅ in `plan.md`.

## Evolution Path

V1 ChatGPT Clone → V2 Memory → V3 RAG → V4 Tool Calling → P0 Platform Foundation → P1 Agent Kernel → V5 Voice → V6 Workflow → V9 Multi-Agent ✅ → V11 Video Conversation ✅ → Agent Runtime Refactor ✅ (customer-chat → agent-runtime)

## Package Layout

| Package | Runtime | Purpose |
|---|---|---|
| `apps/web` | React 19 / Vite 6 / TypeScript | Chat UI on port 5173 |
| `apps/server` | Node.js 20+ / Hono 4 / TypeScript | Backend API on port 8000 |
| `packages/database` | Prisma 6 | Shared Prisma schema + client singleton (`@agentforge/database`) |
| `packages/shared-types` | TypeScript (type-only) | Shared type definitions — no runtime code |
| `packages/shared-prompts` | TypeScript | Centralized prompt registry |
| `packages/sdk` | TypeScript | API client (`AgentForgeClient`) + SSE streaming |

## Data Flow

```
Browser (React) ←SSE/HTTP→ Hono (8000) → LLMProvider (abstract) → OpenAI | DeepSeek
                                    ↓
                    ┌──────────────┼──────────────┐
                    │              │              │
               ChatService   AgentRuntime    Voice/Video
               (/api/chat)   (/api/agent/chat)  (WebSocket)
                    │              │
                    ↓              ↓
              ToolRegistry   AgentExecutor (ReAct)
                    │         ├── Router (SAFETY/CHAT/TASK/HUMAN)
                    │         ├── KnowledgeContextBuilder
                    │         └── CitationVerifier
                    ↓
           @agentforge/database (Prisma)
                    ↓
              PostgreSQL 16
                    ↓
            Milvus Vector DB
```

## Streaming Paths

### Chat API (`/api/chat`)

```
Frontend: POST /api/chat
  → Hono SSE
    → ChatService.streamChat()
      → AgentForgeClient.streamChat()
        → AsyncGenerator<ChatStreamChunk>
          → Zustand store (useChatStore)
```

### Agent Chat API (`/api/agent/chat`)

```
Frontend: POST /api/agent/chat
  → Hono SSE
    → AgentRuntimeService.streamChat()
      → Router (Rule First + LLM Fallback)
        → Agent (SAFETY/CHAT/TASK/HUMAN)
          → useAgentChatStream hook
```

## Agent Runtime Architecture

核心设计：

- **4-Route Classifier**: SAFETY / CHAT / TASK / HUMAN — Rule First + LLM Fallback 三层降级分类
- **AgentExecutor (ReAct)**: 统一的 Agent 执行引擎，动态获取 Tool
- **Tool Layering**: Builtin 层 (`search_knowledge_base`) vs Business 层 (`create_support_ticket`)
- **KnowledgeContextBuilder**: 结构化知识库上下文构建
- **CitationVerifier**: 引用验证

详见：
- `docs/architecture/routing.md` — 路由架构完整数据流转、三层分类管线、Agent 分发
- `docs/architecture/knowledge-hybrid-retrieval.md` — 知识库混合检索全链路（摄入→索引→RRF融合→Reranker精排→降级）
- `docs/agent-runtime.md` — Agent Runtime 状态模型（三维状态机、事件协议）
- `docs/agent-runtime-refactor-plan.md` — 重构方案与背景

## Version Roadmap

详见 `plan.md`。

**Platform Foundation (P0-P1):**

- P0-1 Auth & Multi-Tenancy ✅ — JWT authentication, API keys, per-user data isolation
- P0-2 Structured Logging ✅ — pino-based structured logging with correlation IDs
- P0-3 Testing ✅ — vitest unit + integration tests, CI enforced
- P0-4 CI/CD ✅ — GitHub Actions pipeline (lint → format → typecheck → test → build)
- P0-5 Security ✅ — Rate limiting, Zod validation, content safety
- P1-1 Background Jobs ✅ — BullMQ job queue with Redis
- P1-2 Observability ✅ — Prometheus metrics + OpenTelemetry tracing
- P1-3 Agent Reasoning ✅ — ReAct loop with structured decision output
- P1-4 Working Memory ✅ — Agent scratchpad for multi-step task context
- P1-5 Human-in-the-Loop ✅ — Approval gates with 5-min timeout auto-reject
- P1-6 Tool Ecosystem ✅ — 10 production tools with Docker sandbox

**Agent Capabilities (V1-V11):**

- V1 ChatGPT Clone ✅ — Multi-turn chat, streaming, model switching, provider abstraction
- V2 Memory ✅ — PostgreSQL + Milvus for long-term memory
- V3 RAG ✅ — Document ingestion, hybrid search, knowledge UI
- V4 Tool Calling ✅ — Tool registry and execution engine
- V5 Voice Agent ✅ — WebSocket real-time audio, Whisper ASR, OpenAI TTS
- V6 Workflow Engine ✅ — DAG-based orchestration, checkpoint/resume
- V9 Multi-Agent ✅ — Role-based agent teams, message bus, blackboard
- V11 Multimodal Video ✅ — WebSocket video chat with Vision LLM
- Agent Runtime Refactor ✅ — Unified AgentExecutor, 4-route classifier

**Beyond V11:** Agent evaluation & benchmarking, fine-tuning pipeline, K8s deployment
