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

# One-time Python setup (creates .venv + installs deps)
pnpm api:setup

# Start backend + frontend in dev mode
pnpm dev

# Or start separately in different terminals:
pnpm api:dev       # Backend on :8000
pnpm web:dev       # Frontend on :5173

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

# Python backend — from apps/api/
cd apps/api
.venv/Scripts/python -m alembic upgrade head     # Run DB migrations
.venv/Scripts/python -m alembic revision --autogenerate -m "desc"  # Create migration
.venv/Scripts/python scripts/seed_demo.py        # Seed demo memories
ruff check .                                      # Lint Python code
ruff format .                                     # Format Python code

# Single package dev — from root
pnpm --filter @agentforge/web dev
pnpm --filter @agentforge/web build
```

**Environment setup:** Copy `apps/api/.env.example` to `apps/api/.env` and fill in API keys. The backend reads `.env` from its own directory, not the repo root.

### Startup Flow (Recommended)

The recommended way to start is **layered**:

```bash
# 1st terminal: Start Docker infrastructure (once, stays running)
pnpm infra:up

# 2nd terminal: Setup Python (first time only)
pnpm api:setup
pnpm api:db:migrate

# 3rd terminal: Start backend
pnpm api:dev

# 4th terminal: Start frontend
pnpm web:dev
```

This way each component is independently controllable — restart the backend without touching the DB, rebuild the frontend without restarting Python, etc.

## Architecture

AgentForge is a **pnpm + Turborepo monorepo** building a ChatGPT clone as the foundation (V1) for a progressive AI agent platform (V1→V10: Memory → RAG → Tool Calling → Voice → Workflow → Browser Agent → Multi-Agent → MCP).

### Package Layout

| Package | Runtime | Purpose |
|---------|---------|---------|
| `apps/web` | React 19 / Vite 6 / TypeScript | Chat UI on port 5173 |
| `apps/api` | Python 3.12 / FastAPI | Backend API on port 8000 |
| `packages/shared-types` | TypeScript (type-only) | Shared type definitions — no runtime code |
| `packages/shared-prompts` | TypeScript | Centralized prompt registry |
| `packages/sdk` | TypeScript | API client (`AgentForgeClient`) + SSE streaming |

### Data Flow

```
Browser (React) ←SSE/HTTP→ FastAPI → LLMProvider (abstract) → OpenAI | DeepSeek
                                    ↓
                              PostgreSQL 16
```

**Streaming path:** Frontend calls `POST /api/chat` → FastAPI yields SSE `data:` lines via `sse-starlette` → `AgentForgeClient.streamChat()` parses the `ReadableStream` into an `AsyncGenerator<ChatStreamChunk>` → Zustand store accumulates tokens into messages.

### Key Design Decisions

1. **Provider abstraction** (`apps/api/app/providers/`): All LLM calls go through the `LLMProvider` ABC (`stream_chat()`, `list_models()`). Adding a new provider (Claude, Gemini, etc.) means implementing those two methods — business logic in `chat_service.py` never changes.

2. **Single-tenant MVP:** A default user (`00000000-0000-0000-0000-000000000001`) is auto-seeded on startup. All conversations belong to this user. This is a deliberate V1 simplification.

3. **Conversation titles** are auto-generated from the first line of the first user message (max 80 chars).

4. **Database port is 5434** (not the default 5432) to avoid conflicts. The Docker compose and `start.ps1` both use this non-standard port.

5. **Frontend state:** Zustand for UI state (selected conversation, streaming flag), TanStack Query for server data (conversation list, messages). The three-panel layout is sidebar (conversations) | chat area | debug panel.

6. **Vite proxies** `/api` requests to `localhost:8000` in dev mode, so the frontend uses relative API paths.

7. **Python backend** is installed as an editable package (`pip install -e .`) — the `start.ps1` script handles this automatically. The project uses `pyproject.toml` with setuptools, not Poetry.

8. **No test infrastructure exists yet** — this is V1 foundation. There are no `test` scripts in any `package.json` or turbo pipeline.

### Upcoming Versions (for context)

The `project.md` defines a V1→V10 roadmap. Each version builds on the current architecture without rewrites:
- **V2 Memory:** PostgreSQL + Milvus for long-term memory
- **V3 RAG:** Document ingestion and retrieval
- **V4 Tool Calling:** Tool registry and execution engine
- **V6 Workflow Engine:** Multi-step agent workflows
- **V8 Browser Agent:** Web automation
- **V10 MCP Ecosystem:** Model Context Protocol integration
