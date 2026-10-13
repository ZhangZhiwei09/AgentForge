# Historical Database Schema

This directory archives the original Prisma schema and SQL migration history.
Python schema adoption tests replay these SQL files to verify compatibility.
Do not run Prisma migrations against the Python baseline.

Active models and migrations live in `apps/server-py/src/models` and
`apps/server-py/alembic`. From the repository root:

```bash
pnpm db:migrate
pnpm db:check
pnpm db:admin --email admin@agentforge.local
```

No Prisma client, package installation, generation or Node database tooling is required.
