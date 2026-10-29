# Production Deployment

The production stack consists of pgvector PostgreSQL 16, persistent Redis 7,
a Python API, a Python ARQ worker and two Nginx frontend images. Database upgrades
run as a separate service before API/worker startup. Node is used during frontend
image builds; neither backend image nor runtime needs Node or Prisma.

## Access Model

Production is a single-organization internal service. Compose fixes
`APP_ENV=production`, `DEBUG=false`, `AUTH_SIGNUP_ENABLED=false`,
`ANONYMOUS_CHAT_ENABLED=false` and `PUBLIC_FAQ_ENABLED=false` for the API,
worker and migration service. Development `.env.example` explicitly enables the
three compatibility switches; those values cannot override production Compose.
Production Settings reject debug mode, the default JWT secret and enabled public
switches.

Anonymous chat and public signup are closed; FAQ requires authentication.
Signed-in ordinary users retain knowledge search, their own chat history, tasks
and answer ratings. Knowledge management, ingestion, retrieval debugging,
evaluations, global analytics, flow administration and metrics require `admin`.
An API key carries its owner's current database role; an ordinary user's key
does not grant administrative access.

Provision ordinary users and administrators before directing users to an upgraded
service. Existing accounts, password hashes, API keys and refresh tokens are
retained; no ordinary account is automatically promoted. Preserve the existing
`JWT_SECRET` so issued credentials continue to work. Existing ordinary users of
the administration UI will lose management access and need a separate authorized
administrator account.

## Configuration

Create a private `.env.production` and pass it explicitly to Compose. Required:

```dotenv
POSTGRES_USER=agentforge
POSTGRES_PASSWORD=replace-me
POSTGRES_DB=agentforge
REDIS_PASSWORD=replace-me
DATABASE_URL=postgresql+asyncpg://agentforge:replace-me@db:5432/agentforge
REDIS_URL=redis://:replace-me@redis:6379
JWT_SECRET=replace-with-a-stable-random-secret
OPENAI_API_KEY=replace-with-provider-key
OPENAI_BASE_URL=https://api.openai.com/v1
DEFAULT_MODEL=gpt-4o-mini
EMBEDDING_MODEL=text-embedding-3-small
WEB_PORT=80
ADMIN_PORT=5200
```

URL-encode credentials inside URLs. Keep the JWT secret used by existing users
to preserve their sessions. The retained vector schema is 1024-dimensional:
OpenAI text-embedding-3 models explicitly request 1024; custom providers must
return 1024. Configure `EMBEDDING_API_KEY` and `EMBEDDING_BASE_URL` independently
when using a different embedding provider.

Configure optional Elasticsearch/reranking/Langfuse endpoints as needed.
These services can be operated externally; they are not automatically provisioned
by production Compose. Same-origin Nginx API proxies do not require CORS;
set `CORS_ORIGINS` for external browser origins.

## Startup And Upgrade

From the repository root:

```bash
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml ps -a
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml logs --tail=100 server worker migrate
```

`migrate` creates a fresh database or adopts compatible existing Prisma/Alembic
tables transactionally. Incompatible columns stop startup with a repair error;
no tables or vectors are implicitly dropped/resized. Back up before upgrades.
Run the migration explicitly before restarting an existing deployment:

```bash
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml run --rm migrate
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml up -d --build server worker customer-service data-admin
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml exec server python -m src.database check
```

### Provision Accounts

Run these operator-only commands against the deployment database. For an existing
installation, use the new image to provision accounts after migration and before
reopening frontend traffic. The example commands use a running server container;
`run --rm --no-deps server` can replace `exec server` before the server is started.
Each command prompts for a hidden password when its password environment variable
is absent or empty:

```bash
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml exec server python -m src.database create-admin --email admin@agentforge.local
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml exec server python -m src.database create-user --email user@agentforge.local
```

Both commands validate email and require at least eight characters for new
passwords, using the same password hashing as sign-in. `create-user` always creates
role `user`; `create-admin` always creates role `admin`. Repeating a command for
the same email and role returns the existing ID without changing the password or
other data. A different existing role is an error and leaves the account intact.
These commands do not reset passwords or change roles; do not delete existing
accounts or edit SQL to work around a role conflict.

For unattended provisioning, inject `AGENTFORGE_ADMIN_PASSWORD` or
`AGENTFORGE_USER_PASSWORD` through the deployment's secret environment, then pass
only the environment variable name. For example, when the operator shell already
holds the user password as a secret environment variable:

```bash
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml exec -T -e AGENTFORGE_USER_PASSWORD server python -m src.database create-user --email user@agentforge.local --password-env AGENTFORGE_USER_PASSWORD
```

`create-admin` accepts `--password-env AGENTFORGE_ADMIN_PASSWORD` in the same way.
Custom variable names are also supported. Compose's `--env-file` alone does not
inject these account passwords into containers; forward the selected secret
environment variable explicitly. Never supply a plaintext password as a CLI
argument. Restrict these commands to operators with deployment database access;
ordinary users sign in through the existing authentication API.

### Network

The API binds only the Compose network. Frontend ports are public; terminate TLS
at the deployment gateway. Production `TRUSTED_PROXY_IPS` defaults to the private
network's proxies. Restrict it to actual proxy IPs if connecting other workloads
or exposing the API. Requests must not be allowed to forge forwarded addresses.

## Persistence And Monitoring

`pgdata` retains PostgreSQL, `redis_data` retains AOF queue state, and
`knowledge_files` is mounted read/write by API and worker. Redis uses `noeviction`
so memory pressure rejects writes instead of discarding queued ingestion jobs.
Queue dispatch failures retain pending documents and return 503.

When migrating an existing deployment, reuse its PostgreSQL volume and upload
storage. Preserve legacy `apps/server/data/knowledge-files`; mount or copy it to
the configured storage root before enabling the new API. Database rows containing
absolute paths need those paths mounted at the same container location, or an
explicit data migration. Do not remove old volumes until restored data and files
have been verified.

`/api/health` is liveness; `/api/ready` verifies SQL, provider configuration and
required Redis. `/api/metrics` requires administrator authentication. Grafana
queries are in `infra/dashboards/agentforge.json`. Readiness validates configured credentials,
not a paid live model request. Monitor worker logs and failed document status.
Interrupted task sessions may require operator reconciliation; tools with uncertain
external outcomes are not automatically replayed.

### Metrics Credentials

Sign in as a provisioned administrator and create a key with
`POST /api/auth/api-keys`, sending the administrator access token as
`Authorization: Bearer <accessToken>` and JSON `{"name":"production-metrics"}`.
Store the returned `key` in the metrics collector's secret store; it is returned
only at creation. Configure the collector to scrape `/api/metrics` with
`Authorization: Bearer <key>`, preferably through the private Compose network.
For Prometheus on that network, an authorization file can contain the key:

```yaml
scrape_configs:
  - job_name: agentforge
    metrics_path: /api/metrics
    static_configs:
      - targets: ["server:8000"]
    authorization:
      type: Bearer
      credentials_file: /run/secrets/agentforge_metrics_api_key
```

An anonymous scrape returns 401; an ordinary user's token or API key returns 403.
Keys use the owner's current role, so removing that role also removes scrape
access. The current admin key also authorizes management operations; restrict the
collector's network access and secret storage accordingly. Revoke an old key via
`DELETE /api/auth/api-keys/{key_id}` after switching the collector to its replacement.
Upgrades do not regenerate existing keys.

See [backup and restore](backup-restore.md). Back up upload storage together with
PostgreSQL and test restoration into a disposable environment.
