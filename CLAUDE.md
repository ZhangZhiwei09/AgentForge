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

**Evolution path:** V1 ChatGPT Clone → V2 Memory → V3 RAG → V4 Tool Calling → P0 Platform Foundation → P1 Agent Kernel → V5 Voice → V6 Workflow → V9 Multi-Agent ✅ → V11 Video Conversation ✅ → Agent Runtime Refactor ✅ (customer-chat → agent-runtime)

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

**Streaming paths:**
- `/api/chat`: Frontend calls `POST /api/chat` → Hono SSE → `ChatService.streamChat()` → `AgentForgeClient.streamChat()` parses `AsyncGenerator<ChatStreamChunk>` → Zustand store
- `/api/agent/chat`: Frontend calls `POST /api/agent/chat` → Hono SSE → `AgentRuntimeService.streamChat()` → Router → Agent → `useAgentChatStream` hook


## Development Workflow: Multi-Agent Pipeline

All non-trivial features follow a **5-stage gated pipeline** with four specialized agents. Each stage acts as a gate — the work cannot proceed until the current gate approves.

```
Architect ──→ Architecture Reviewer ──→ Code Agent ──→ Architect (Review) ──→ Professional Reviewer
   │              │                        │               │                        │
   │         CHANGES_REQUIRED          REWORK_REQUIRED  CHANGES_REQUIRED          APPROVED
   └──────────────┘                        └───────────────┘                        │
        (loop)               (loop)            (loop)                          ✅ Done
```

### Stage 1: Architect (Design)

**Agent:** `principal-architect` (Design Mode)

**Input:** Feature requirements or task description.

**Output:** A design plan containing:
- Architecture decisions and trade-offs
- Component/file-level breakdown
- Data flow and API contracts
- Task decomposition with dependencies
- Risk analysis and mitigation

**Gate:** Output must be a complete, reviewable design document.

### Stage 2: Architecture Reviewer

**Agent:** `architecture-reviewer`

**Input:** Architect's design plan.

**Output:** A verdict:
- **APPROVED** → proceed to Stage 3 (Code Agent)
- **CHANGES_REQUIRED** → return to Stage 1 (Architect) with specific issues to address

**What it checks:** Design soundness, trade-off合理性, consistency with existing architecture, scalability, security posture, and feasibility.

### Stage 3: Code Agent (Implementation)

**Agent:** `implementation-engineer`

**Input:** Approved design plan from Stage 2.

**Output:** Working code that faithfully implements the design. The implementation engineer does NOT redesign — it follows the plan exactly. If the plan has gaps, it flags them rather than improvising.

**Gate:** All planned files created/modified, tests pass, no architectural drift.

### Stage 4: Architect Review (Implementation Compliance)

**Agent:** `principal-architect` (Review Mode)

**Input:** The implemented code + the original approved design plan.

**Output:** A compliance verdict:
- **PASS** → proceed to Stage 5 (Professional Reviewer)
- **REWORK_REQUIRED** → return to Stage 3 (Code Agent) with specific deviations listed

**What it checks:** Does the code match the design? Are there unplanned architectural changes? Did any design assumptions break during implementation?

### Stage 5: Professional Reviewer (Code Quality)

**Agent:** `principal-code-reviewer`

**Input:** The implemented code.

**Output:** A structured review with issues classified as:
- **P0 (Blocking):** Must fix before merge — correctness, security, data loss
- **P1 (Must Fix):** Should fix — reliability, performance, maintainability
- **P2 (Suggestion):** Nice to have — readability, style, minor optimizations

**Gate:**
- **APPROVED** (no P0 issues) → ✅ Task complete, ready to merge
- **CHANGES_REQUIRED** (P0 issues present) → return to Stage 3 (Code Agent)

### Agent Mapping Summary

| Stage | Role | Agent Type | Mode |
|-------|------|-----------|------|
| 1 | Architect | `principal-architect` | Design |
| 2 | Architecture Reviewer | `architecture-reviewer` | Review |
| 3 | Code Agent | `implementation-engineer` | Implement |
| 4 | Architect (Review) | `principal-architect` | Review |
| 5 | Professional Reviewer | `principal-code-reviewer` | Review |

### When to Use This Pipeline

Use the full pipeline for:
- New features (new routes, services, components)
- Significant refactoring (changes spanning 3+ files)
- API design changes
- Database schema changes

Skip to Stage 3 directly for:
- Bug fixes with clear root cause
- Small, well-defined changes following existing patterns
- Configuration updates
- Documentation changes

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
- **P0-3 Testing:** ✅ vitest unit + integration tests, CI enforced
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
- **Agent Runtime Refactor:** ✅ Renamed `customer-chat` → `agent-runtime`. 4-route classifier (SAFETY/CHAT/TASK/HUMAN). Unified `AgentExecutor` with dynamic tool fetching. Tool layering: Builtin (`search_knowledge_base`) vs Business (`create_support_ticket`). `KnowledgeContextBuilder` for structured KB context. Removed e-commerce tools, video chat, and order/policy cards. Conversation type: `agent_chat`. See `docs/agent-runtime-refactor-plan.md`.

**Beyond V11:**

- Agent evaluation & benchmarking, fine-tuning pipeline, multi-modal, K8s deployment
