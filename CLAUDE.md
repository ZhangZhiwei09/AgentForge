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

AgentForge is a **pnpm + Turborepo monorepo** building a ChatGPT clone as the foundation (V1) for a progressive AI agent platform. The roadmap spans platform engineering (P0-P2) and agent capability phases (V5-V9, V11). Completed phases are marked with ✅ in both this file and `plan.md`.

**Evolution path:** V1 ChatGPT Clone → V2 Memory → V3 RAG → V4 Tool Calling → P0 Platform Foundation → P1 Agent Kernel → V5 Voice → V6 Workflow → V9 Multi-Agent ✅ → V11 Video Conversation ✅

### Package Layout

| Package       | Runtime                           | Purpose                  |
| ------------- | --------------------------------- | ------------------------ |
| `apps/web`    | React 19 / Vite 6 / TypeScript    | Chat UI on port 5173     |
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

11. **Tool Calling + P1-6 Tool Ecosystem ✅** (`apps/server/src/tools/`): 10 production tools — `get_current_time`, `calculator`, `web_search` (Tavily API), `http_request`, `file_read`, `file_write`, `file_search`, `db_query` (read-only SQL via Prisma), `web_fetch` (URL content retrieval), `code_execute` (Docker sandbox, supports Python/JavaScript). Server-side multi-round tool calling loop in `ChatService.streamChat()` (max 5 rounds). Tools are registered via `ToolRegistry` singleton and sent to LLM only when explicitly requested via `tools` param. Each tool has riskLevel, timeout, optional requireApproval, and sandbox flag. Circuit breaker trips after 5 consecutive failures (60s cooldown). Prometheus metrics: `tool_calls_total`, `tool_execution_duration_ms`, `circuit_breaker_state`. Docker sandbox (`apps/server/src/services/sandbox.ts`) provides isolated code execution with no network, read-only filesystem, 256MB memory limit, and 60s timeout. Build sandbox image: `docker build -t agentforge-sandbox:latest -f infra/docker/Dockerfile.sandbox .`

12. **Agent Kernel (P1-3 ✅ + P1-4 ✅):** `AgentService` (`apps/server/src/services/agent.ts`) implements ReAct (Reasoning + Acting) loop with structured JSON decision output. Agent sessions are persisted in `agent_sessions` table with full scratchpad of reasoning steps. Agent panel in frontend shows reasoning chain (observation → analysis → plan → decision → result). SSE protocol extended with `agent_think`, `agent_act`, `agent_observe`, `agent_respond`, `agent_ask_user`, `agent_done` event types. Supports max iterations (default 10), ask_user pauses, and graceful error handling.

13. **Testing (P0-3 ✅):** 12 test files with 159 tests total (132 pass, 20 auth integration tests require test DB, 7 skipped). Key files: AuthService (20), ToolRegistry (12+), AgentService (12), AgentApproval/P1-5 (6), ChatService (12), MemoryEngine (14), KnowledgeService, BM25 (5), OpenAI provider (13), DeepSeek provider (12), customer-chat-eval, rate-limit-store. Run via `pnpm test` in server package. (Auth integration tests require test DB config.)

14. **Content Safety (P0-5 ✅):** Prompt injection detection middleware with 20+ pattern rules, message length limits (16k chars), and Zod validation on all input routes.

15. **Observability (P1-2 ✅):** Prometheus metrics at `GET /api/metrics` (HTTP request count/duration, LLM call/token counts, tool execution, memory extraction, Milvus search latency). OpenTelemetry tracing with conditional OTLP export to Jaeger (enable via `OTEL_ENABLED=true`). Grafana dashboard template at `apps/server/dashboards/agentforge.json`.

16. **Voice Agent (V5 ✅):** WebSocket-based real-time voice via `WS /api/voice/stream`. Pipeline: Browser PCM → VAD → WebSocket → ASR (Whisper) → LLM (ChatService) → TTS (OpenAI, 6 voices) → MP3 playback. `VoiceService` (`apps/server/src/services/voice.ts`) manages turn state machine with `AbortController`-based interruption. Audio providers (`apps/server/src/services/audio-providers.ts`) follow lazy registry pattern. Voice sessions in `voice_sessions` table. Frontend: `VoicePanel` with mic, waveform, voice selector, transcript. HTTP: `POST /api/voice/transcribe`, `POST /api/voice/synthesize`, `GET /api/voice/voices`. Backward compatible — text chat unaffected.

### Keeping CLAUDE.md in Sync with plan.md

When a development phase from `plan.md` is completed:

1. Mark the phase with ✅ in `plan.md` (version roadmap + acceptance criteria)
2. Update the "Version Roadmap" section above with the same ✅ and a brief description of what was built
3. If the phase introduced new packages, commands, or architectural patterns, add them to the relevant sections

This ensures CLAUDE.md always reflects the current state of the project, not just the original plan.

### Version Roadmap (V1→V11 + P0-P2)

The `plan.md` defines the full V1→V11 + P0-P2 roadmap. Completed phases are marked with ✅. When a new phase is completed, update both `plan.md` and this section.

**Platform Foundation:**

- **P0-1 Auth & Multi-Tenancy:** ✅ JWT authentication, API keys, per-user data isolation
- **P0-2 Structured Logging:** ✅ pino-based structured logging with correlation IDs
- **P0-3 Testing:** ✅ vitest unit + integration tests (36 tests, CI enforced)
- **P0-4 CI/CD:** ✅ GitHub Actions pipeline (lint → format → typecheck → test → build)
- **P0-5 Security:** ✅ Rate limiting, Zod validation, content safety (prompt injection detection)
- **P1-1 Background Jobs:** ✅ BullMQ job queue for async memory extraction + knowledge ingestion with Redis
- **P1-2 Observability:** ✅ Prometheus metrics + OpenTelemetry tracing
- **P1-3 Agent Reasoning:** ✅ ReAct loop with structured decision output
- **P1-4 Working Memory:** ✅ Agent scratchpad for multi-step task context
- **P1-5 Human-in-the-Loop:** ✅ Approval gates for high-risk tool operations with 5-min timeout auto-reject, audit log
- **P1-6 Tool Ecosystem:** ✅ 10 production tools with Docker sandbox, circuit-breakers, and Prometheus metrics

**Agent Capabilities:**

- **V1 ChatGPT Clone:** Multi-turn chat, streaming, model switching, provider abstraction ✅
- **V2 Memory:** PostgreSQL + Milvus for long-term memory ✅
- **V3 RAG:** Document ingestion, hybrid search, knowledge UI, customer chat ✅
- **V4 Tool Calling:** Tool registry and execution engine ✅
- **V5 Voice Agent:** ✅ WebSocket real-time audio, Whisper ASR, OpenAI TTS (6 voices), VAD, interruption handling
- **V6 Workflow Engine:** ✅ DAG-based orchestration, checkpoint/resume, 6 step types, 3 templates, 15 API endpoints
- **V9 Multi-Agent:** ✅ Role-based agent teams, message bus, 3 collaboration patterns, blackboard, 4 templates, 16 API endpoints
- **V11 Multimodal Video Conversation:** ✅ WebSocket-based video chat with AI customer service agent. Camera + mic → ASR + GPT-4o Vision → TTS. Canvas frame capture (1fps JPEG), multimodal LLM provider, VideoCallPanel UI. Phase 1 complete; Phase 2 (WebRTC/RTC upgrade) planned.

**Beyond V11:**

- Agent evaluation & benchmarking, fine-tuning pipeline, multi-modal, K8s deployment
