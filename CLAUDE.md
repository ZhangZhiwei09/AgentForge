# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

AgentForge is a **pnpm + Turborepo monorepo** building a ChatGPT clone as the foundation (V1) for a progressive AI agent platform (V1→V10: Memory → RAG → Tool Calling → Voice → Workflow → Browser Agent → Multi-Agent → MCP).

### Package Layout

| Package | Runtime | Purpose |
|---------|---------|---------|
| `apps/web` | React 19 / Vite 6 / TypeScript | Chat UI on port 5173 |
| `apps/server` | Node.js 20+ / Hono 4 / TypeScript | Backend API on port 8000 |
| `apps/api` | Python 3.12 / FastAPI | **Retained for reference only — not running** |
| `packages/database` | Prisma 6 | Shared Prisma schema + client singleton (`@agentforge/database`) |
| `packages/shared-types` | TypeScript (type-only) | Shared type definitions — no runtime code |
| `packages/shared-prompts` | TypeScript | Centralized prompt registry |
| `packages/sdk` | TypeScript | API client (`AgentForgeClient`) + SSE streaming |

### Data Flow

```
Browser (React) ←SSE/HTTP→ Hono (8000) → LLMProvider (abstract) → OpenAI | DeepSeek
                                    ↓
                       @agentforge/database (Prisma)
                                    ↓
                              PostgreSQL 16
                                    ↓
                            Milvus Vector DB
```

**Streaming path:** Frontend calls `POST /api/chat` → Hono SSE via `streamSSE()` yields `data: {json}\n\n` lines → `AgentForgeClient.streamChat()` parses the `ReadableStream` into an `AsyncGenerator<ChatStreamChunk>` → Zustand store accumulates tokens into messages.

### Key Design Decisions

1. **Provider abstraction** (`apps/server/src/providers/`): All LLM calls go through the `LLMProvider` interface (`streamChat()`, `listModels()`). Adding a new provider means implementing those two methods — business logic in `chat.ts` never changes.

2. **Prisma as shared package** (`packages/database/`): Single source of truth for the data model. All packages import `prisma` from `@agentforge/database`. Migrations are managed independently via `pnpm db:migrate`.

3. **Single-tenant MVP:** A default user (`00000000-0000-0000-0000-000000000001`) is auto-seeded on startup. All conversations belong to this user.

4. **Conversation titles** are auto-generated from the first line of the first user message (max 80 chars).

5. **Database port is 5434** (not the default 5432) to avoid conflicts.

6. **Frontend state:** Zustand for UI state, TanStack Query for server data. Three-panel layout: sidebar | chat area | debug panel.

7. **Vite proxies** `/api` requests to `localhost:8000` in dev mode — no changes needed when switching backends.

8. **UUID generation** uses Node.js built-in `crypto.randomUUID()` — no external uuid package needed.

9. **SSE format** is strictly `data: {json}\n\n` + `data: [DONE]\n\n` — the frontend SDK's stream parser depends on this exact format.

10. **DB schema is baseline-introspected** from the existing Python Alembic tables. The Prisma schema uses `@@map`/`@map` for snake_case column names. IDs are `@db.VarChar(36)` (not UUID type), so UUIDs are generated in application code.

### Python Backend (Retained)

The original Python FastAPI backend lives in `apps/api/` and is preserved for reference. It is not included in the Turbo pipeline (`turbo dev` filters `@agentforge/server` + `@agentforge/web` only). The Python code, Alembic migrations, and models remain untouched.

### Upcoming Versions

The `project.md` defines a V1→V10 roadmap:
- **V2 Memory:** PostgreSQL + Milvus for long-term memory ✅
- **V3 RAG:** Document ingestion and retrieval ✅
- **V4 Tool Calling:** Tool registry and execution engine
- **V6 Workflow Engine:** Multi-step agent workflows
- **V8 Browser Agent:** Web automation
- **V10 MCP Ecosystem:** Model Context Protocol integration
