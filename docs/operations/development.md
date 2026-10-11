# Development Guide

## Environment Setup

1. Copy `apps/server/.env` (created during setup) and fill in API keys.
2. Copy `packages/database/.env` to the same and set the `DATABASE_URL`.

## Common Commands

### Infrastructure

```bash
pnpm infra:up        # Start services from infra/docker/docker-compose.yml
pnpm infra:down      # Stop infrastructure
pnpm infra:restart   # Restart infrastructure
```

### Development

```bash
pnpm install         # Install all dependencies
pnpm dev             # Start TS API + Python flow runtime + both frontends
pnpm server:dev      # Backend only on :8000 (TS Hono, tsx watch)
pnpm cs:dev          # Diagnosis frontend on :5173
pnpm admin:dev       # Administration frontend on :5200
pnpm py:dev          # Python configured-flow runtime on :8004 (requires uv + Python 3.12+)

# Single package dev — from root
pnpm --filter @agentforge/customer-service dev
pnpm --filter @agentforge/customer-service build
pnpm --filter @agentforge/server dev
```

### Quality

```bash
pnpm build           # Build all packages
pnpm typecheck       # Typecheck all packages
pnpm lint            # Lint all packages
pnpm format          # Format all source files
```

### Database

```bash
pnpm db:generate     # Regenerate Prisma Client
pnpm db:migrate      # Run Prisma migrations
pnpm db:seed         # Seed users + knowledge base
pnpm db:studio       # Open Prisma Studio GUI
```

## Recommended Startup Flow (Layered)

The recommended way to start is **layered** — each component independently controllable:

```bash
# 1st terminal: Start Docker infrastructure (once, stays running)
pnpm infra:up

# 2nd terminal: Generate Prisma client + run migrations (first time)
pnpm db:generate
pnpm db:migrate

# 3rd terminal: Start both backends and frontends
pnpm dev
```

For independent restarts, use the per-service commands above. The Python launcher
inherits the database, JWT secret and model configuration from `apps/server/.env`;
the TypeScript API uses `AGENT_FLOW_BACKEND_URL` (default `http://127.0.0.1:8004`).

The administration UI has two modules: knowledge management (including feedback)
and Agent flows (including entry routing). Langfuse opens as an external link;
set `VITE_LANGFUSE_URL` in `apps/data-admin/.env.local` to change its destination.

## Database Workflow

When schema drift occurs:

1. Reset DB: `pnpm infra:down && pnpm infra:up`
2. Regenerate client: `pnpm db:generate`
3. Run migrations: `pnpm db:migrate -- --name <migration_name>`
4. Seed: `pnpm db:seed`

## pnpm on Windows

Workspace scripts may fail in Git Bash on Windows. Use full filter commands:

```bash
# ❌ May fail in bash
pnpm server:dev

# ✅ Always works
pnpm --filter @agentforge/server dev
```
