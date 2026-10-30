# Development Guide

The public API and ingestion worker run in Python. Node/pnpm build and serve
the two React applications and shared frontend packages.

## Setup

Install Node 20+, pnpm 9.15.4, Python 3.12+, uv and Docker Compose 2.24+.
Run `pnpm install --frozen-lockfile` and `uv sync --locked` from `apps/server-py`.
Create `apps/server-py/.env` from the root `.env.example` and configure the model.
Do not overwrite an existing local environment file.

The launcher reads process environment first, then Python `.env`, root `.env`,
and finally legacy `apps/server/.env`. Legacy files are a compatibility fallback;
no Node process or package is needed. `DATABASE_URL` is normalized to asyncpg.

```bash
pnpm infra:up
pnpm db:migrate
pnpm db:check
pnpm db:admin --email admin@agentforge.local
pnpm dev
```

Customer UI: port 5173. Administration: port 5200. API/OpenAPI: port 8000.
`db:admin` prompts for a password or reads `AGENTFORGE_ADMIN_PASSWORD`; it does
not change an existing administrator or promote an ordinary account.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm server:dev` / `pnpm py:dev` | Python public API with reload |
| `pnpm server:worker` | Python ARQ ingestion worker |
| `pnpm admin:dev` / `pnpm cs:dev` | Frontend development servers |
| `pnpm dev:agent-flows` | One Python API and both UIs on available ports |
| `pnpm db:seed` | Idempotent identity KB examples, pending ingestion |
| `pnpm db:seed --process` | Ingest examples through the configured embedding provider |
| `pnpm db:seed:intents` | Historical semantic-router examples; not used by enterprise entry |
| `pnpm typecheck` / `pnpm build` | Frontend typecheck/build |
| `pnpm py:test` | Python regression suite |

Both Vite proxies accept `AGENTFORGE_API_URL`. `src.dev --public` remains an alias
for the default launch; `--flow-service` explicitly selects old port 8004.
Asynchronous ingestion requires `INGESTION_ASYNC_ENABLED=true`, the worker and
persistent Redis with `noeviction`. Local ingestion defaults to synchronous.
Existing upload paths remain readable; new installations can use Python's data directory.

## Acceptance

Use a separate database named `agentforge_test_*`; browser fixtures refuse other
databases. Bootstrap it with Python, then start API, customer UI and admin UI with
the same database/JWT secret. Set `RATE_LIMIT_MAX=10000` only for this isolated
acceptance server. Forwarded headers are not a way to bypass production limits.

```bash
# From apps/server-py, in its own terminal:
uv run --locked python -m tests.embedding_stub
```

For deterministic ingestion acceptance, set API `EMBEDDING_API_KEY=fixture`,
`EMBEDDING_BASE_URL=http://127.0.0.1:8011/v1` and
`INGESTION_ASYNC_ENABLED=false`. This test provider returns synthetic vectors;
it does not measure real embedding quality. Disable external Elasticsearch/MinIO
for this isolated test run, and leave chat model keys empty.

Set `MONITORING_MODE=mock` explicitly on this isolated acceptance API to expose
the sample trace tool required by flow publishing tests. Keep the normal and
production defaults disabled. Mock mode only serves known sample IDs such as
`abc123`; unknown IDs produce no evidence. Optional live-model diagnosis tests
also require `MONITORING_MODE=mock` in the browser-test terminal and retain their
separate live-model flags. They validate orchestration using synthetic evidence,
not real incident diagnosis.

Set these variables in the browser-test terminal:
`AGENTFORGE_E2E_DATABASE_URL`, `JWT_SECRET`, `AGENT_FLOW_ADMIN_URL=http://localhost:5200`,
and `AGENTFORGE_E2E_EMBEDDINGS=1`, then run:

```bash
pnpm --filter @agentforge/data-admin exec playwright install chromium
pnpm --filter @agentforge/data-admin exec playwright test
```

Real tests cover auth/refresh/signout, knowledge creation/upload/processing/search,
chat/history, flow editing/publication and permissions. Remaining canvas/navigation
tests mock HTTP. Desktop/mobile screenshots are written to the OS temporary
`agent-flow-playwright` directory. Explicit live-model flags in flow tests remain
opt-in and incur provider usage.

Python SQL integration uses `AGENTFORGE_TEST_POSTGRES_URL` with a disposable database
and unique schemas, including when `public` already contains application tables.
ARQ integration uses `AGENTFORGE_TEST_REDIS_URL`; memory integration uses
`REDIS_TEST_URL`. Set `AGENT_FLOW_INTEGRATION=1` with a bootstrapped `DATABASE_URL`
named `agentforge_test_*` for real flow/checkpoint persistence with deterministic
model responses. CI enables these checks. On Windows,
if the default pytest temp root is inaccessible, pass a new `--basetemp` under
the workspace. Never point browser fixtures or test servers at business data.
