# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commit Conventions

All commits must follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — new feature
- `fix:` — bug fix
- `chore:` — maintenance, deps, config
- `refactor:` — code restructuring without behavior change
- `docs:` — documentation only
- `test:` — adding or updating tests
- `ci:` — CI/CD changes
- `style:` — formatting, whitespace (not logic)

## Common Commands

```bash
# Install all dependencies
pnpm install

# Start infrastructure (PostgreSQL, pgAdmin, Milvus) — once per machine
pnpm infra:up
pnpm infra:down    # Stop infrastructure
pnpm infra:restart # Restart infrastructure

# Start backend + frontend in dev mode
pnpm dev

# Or start separately in different terminals:
pnpm server:dev     # Backend on :8000 (TS Hono)
pnpm web:dev        # Frontend on :5173

# One-click script (Windows only — does infra + setup + dev all at once)
pnpm start

# Build all packages
pnpm build

# Typecheck all packages
pnpm typecheck

# Lint all packages
pnpm lint

# Format all source files
pnpm format

# Database — from root
pnpm db:migrate     # Run Prisma migrations
pnpm db:seed        # Seed users + knowledge base
pnpm db:studio      # Open Prisma Studio GUI
pnpm db:generate    # Regenerate Prisma Client

# TS backend — from apps/server/
cd apps/server
pnpm dev            # Dev with hot reload (tsx watch)

# Single package dev — from root
pnpm --filter @agentforge/web dev
pnpm --filter @agentforge/web build
pnpm --filter @agentforge/server dev
```

**Environment setup:** Copy `apps/server/.env` (created during setup) and fill in API keys. Copy `packages/database/.env` to the same and set the DATABASE_URL.

### Startup Flow (Recommended)

The recommended way to start is **layered**:

```bash
# 1st terminal: Start Docker infrastructure (once, stays running)
pnpm infra:up

# 2nd terminal: Generate Prisma client + run migrations (first time)
pnpm db:generate
pnpm db:migrate

# 3rd terminal: Start backend
pnpm server:dev

# 4th terminal: Start frontend
pnpm web:dev
```

This way each component is independently controllable — restart the backend without touching the DB, rebuild the frontend without restarting the server, etc.

## Architecture

AgentForge is a **pnpm + Turborepo monorepo** building a ChatGPT clone as the foundation (V1) for a progressive AI agent platform. The roadmap spans platform engineering (P0-P2) and agent capability phases (V5-V10). Completed phases are marked with ✅ in both this file and `plan.md`.

**Evolution path:** V1 ChatGPT Clone → V2 Memory → V3 RAG → V4 Tool Calling → P0 Platform Foundation → P1 Agent Kernel → V5 Voice → V6 Workflow → V9 Multi-Agent → V10 MCP

### Package Layout

| Package | Runtime | Purpose |
|---------|---------|---------|
| `apps/web` | React 19 / Vite 6 / TypeScript | Chat UI on port 5173 |
| `apps/server` | Node.js 20+ / Hono 4 / TypeScript | Backend API on port 8000 |

| `packages/database` | Prisma 6 | Shared Prisma schema + client singleton (`@agentforge/database`) |
| `packages/shared-types` | TypeScript (type-only) | Shared type definitions — no runtime code |
| `packages/shared-prompts` | TypeScript | Centralized prompt registry |
| `packages/sdk` | TypeScript | API client (`AgentForgeClient`) + SSE streaming |

### Data Flow

```
Browser (React) ←SSE/HTTP→ Hono (8000) → LLMProvider (abstract) → OpenAI | DeepSeek
                                    ↓
                               ChatService
                              ↙           ↘
                 ToolRegistry          @agentforge/database (Prisma)
                                           ↓
                                     PostgreSQL 16
                                           ↓
                                   Milvus Vector DB
```

**Streaming path:** Frontend calls `POST /api/chat` → Hono SSE via `streamSSE()` yields `data: {json}\n\n` lines → `AgentForgeClient.streamChat()` parses the `ReadableStream` into an `AsyncGenerator<ChatStreamChunk>` → Zustand store accumulates tokens into messages.

### Key Design Decisions

1. **Provider abstraction** (`apps/server/src/providers/`): All LLM calls go through the `LLMProvider` interface (`streamChat()`, `listModels()`). Adding a new provider means implementing those two methods — business logic in `chat.ts` never changes.

2. **Prisma as shared package** (`packages/database/`): Single source of truth for the data model. All packages import `prisma` from `@agentforge/database`. Migrations are managed independently via `pnpm db:migrate`.

3. **Auth & Multi-Tenancy (P0-1 ✅):** JWT-based authentication with refresh token rotation and API key support. Default users seeded for dev: `default@agentforge.local` and `customer@agentforge.local`. All routes validate per-user data isolation via auth middleware.

4. **Conversation titles** are auto-generated from the first line of the first user message (max 80 chars).

5. **Database port is 5434** (not the default 5432) to avoid conflicts.

6. **Frontend state:** Zustand for UI state, TanStack Query for server data. Three-panel layout: sidebar | chat area | debug panel.

7. **Vite proxies** `/api` requests to `localhost:8000` in dev mode — no changes needed when switching backends.

8. **UUID generation** uses Node.js built-in `crypto.randomUUID()` — no external uuid package needed.

9. **SSE format** is strictly `data: {json}\n\n` + `data: [DONE]\n\n` — the frontend SDK's stream parser depends on this exact format.

10. **DB schema** uses Prisma with `@@map`/`@map` for snake_case column names. IDs are `@db.VarChar(36)` (not UUID type), so UUIDs are generated in application code.

11. **Tool Calling** (`apps/server/src/tools/`): Server-side multi-round tool calling loop in `ChatService.streamChat()` (max 5 rounds). Tools are registered via `ToolRegistry` singleton and sent to LLM only when explicitly requested via `tools` param. The SSE protocol extends with `tool_call` and `tool_result` event types. Built-in tools include `get_current_time`, `calculator`, `web_search` (Tavily API), `http_request`, `file_read`, `file_write`, `file_search`. Each tool has riskLevel, timeout, and optional approval requirement. Circuit breaker trips after 5 consecutive failures (60s cooldown). The `LLMProvider` interface was extended with `ChatMessage` type (supporting `tool_calls` and `tool_call_id` fields) and an optional `tools` parameter.

12. **Agent Kernel (P1-3 ✅ + P1-4 ✅):** `AgentService` (`apps/server/src/services/agent.ts`) implements ReAct (Reasoning + Acting) loop with structured JSON decision output. Agent sessions are persisted in `agent_sessions` table with full scratchpad of reasoning steps. Agent panel in frontend shows reasoning chain (observation → analysis → plan → decision → result). SSE protocol extended with `agent_think`, `agent_act`, `agent_observe`, `agent_respond`, `agent_ask_user`, `agent_done` event types. Supports max iterations (default 10), ask_user pauses, and graceful error handling.

13. **Testing (P0-3 ✅):** 42 tests across 6 test files — AuthService (20 tests), AgentService (12 tests), AgentService Approval/P1-5 (6 tests), ToolRegistry (11 tests), BM25 (5 tests). Run via `pnpm test` in server package. (Auth tests require test DB config.)

14. **Content Safety (P0-5 ✅):** Prompt injection detection middleware with 20+ pattern rules, message length limits (16k chars), and Zod validation on all input routes.


### Keeping CLAUDE.md in Sync with plan.md

When a development phase from `plan.md` is completed:
1. Mark the phase with ✅ in `plan.md` (version roadmap + acceptance criteria)
2. Update the "Version Roadmap" section above with the same ✅ and a brief description of what was built
3. If the phase introduced new packages, commands, or architectural patterns, add them to the relevant sections

This ensures CLAUDE.md always reflects the current state of the project, not just the original plan.

### Version Roadmap (V1→V10 + P0-P2)

The `plan.md` defines the full V1→V10 + P0-P2 roadmap. Completed phases are marked with ✅. When a new phase is completed, update both `plan.md` and this section.

**Platform Foundation:**
- **P0-1 Auth & Multi-Tenancy:** ✅ JWT authentication, API keys, per-user data isolation
- **P0-2 Structured Logging:** ✅ pino-based structured logging with correlation IDs
- **P0-3 Testing:** ✅ vitest unit + integration tests (36 tests, CI enforced)
- **P0-4 CI/CD:** ✅ GitHub Actions pipeline (lint → format → typecheck → test → build)
- **P0-5 Security:** ✅ Rate limiting, Zod validation, content safety (prompt injection detection)
- **P1-1 Background Jobs:** ✅ BullMQ job queue for async memory extraction + knowledge ingestion with Redis
- **P1-2 Observability:** ⬜ Prometheus metrics + OpenTelemetry tracing
- **P1-3 Agent Reasoning:** ✅ ReAct loop with structured decision output
- **P1-4 Working Memory:** ✅ Agent scratchpad for multi-step task context
- **P1-5 Human-in-the-Loop:** ✅ Approval gates for high-risk tool operations with 5-min timeout auto-reject, audit log
- **P1-6 Tool Ecosystem:** 🔄 7 production tools with timeouts/circuit-breakers (code sandbox pending)

**Agent Capabilities:**
- **V1 ChatGPT Clone:** Multi-turn chat, streaming, model switching, provider abstraction ✅
- **V2 Memory:** PostgreSQL + Milvus for long-term memory ✅
- **V3 RAG:** Document ingestion, hybrid search, knowledge UI, customer chat ✅
- **V4 Tool Calling:** Tool registry and execution engine ✅
- **V5 Voice Agent:** WebSocket real-time audio, ASR/TTS, interruption handling
- **V6 Workflow Engine:** DAG-based orchestration, checkpoint/resume, human approval nodes
- **V9 Multi-Agent:** Role-based agent teams, message bus, 3 collaboration patterns
- **V10 MCP Ecosystem:** MCP Server + Client, dynamic tool discovery, hot-reload

**Beyond V10:**
- Agent evaluation & benchmarking, fine-tuning pipeline, multi-modal, K8s deployment
