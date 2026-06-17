# Development Guide

## Environment Setup

1. Copy `apps/server/.env` (created during setup) and fill in API keys.
2. Copy `packages/database/.env` to the same and set the `DATABASE_URL`.

## Common Commands

### Infrastructure

```bash
pnpm infra:up        # Start PostgreSQL + pgAdmin + Milvus (Docker)
pnpm infra:down      # Stop infrastructure
pnpm infra:restart   # Restart infrastructure
```

### Development

```bash
pnpm install         # Install all dependencies
pnpm dev             # Start backend + frontend concurrently
pnpm server:dev      # Backend only on :8000 (TS Hono, tsx watch)
pnpm web:dev         # Frontend only on :5173

# Single package dev — from root
pnpm --filter @agentforge/web dev
pnpm --filter @agentforge/web build
pnpm --filter @agentforge/server dev

# One-click script (Windows only)
pnpm start           # infra + setup + dev all at once
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

# 3rd terminal: Start backend
pnpm server:dev

# 4th terminal: Start frontend
pnpm web:dev
```

This way you can restart the backend without touching the DB, rebuild the frontend without restarting the server, etc.

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
