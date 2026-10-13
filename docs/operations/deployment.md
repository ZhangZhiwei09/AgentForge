# Production Deployment

The production stack consists of pgvector PostgreSQL 16, persistent Redis 7,
a Python API, a Python ARQ worker and two Nginx frontend images. Database upgrades
run as a separate service before API/worker startup. Node is used during frontend
image builds; neither backend image nor runtime needs Node or Prisma.

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
docker compose --env-file .env.production -f infra/docker/docker-compose.prod.yml exec server python -m src.database create-admin --email admin@agentforge.local
```

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
required Redis. `/api/metrics` requires authentication. Grafana queries are in
`infra/dashboards/agentforge.json`. Readiness validates configured credentials,
not a paid live model request. Monitor worker logs and failed document status.
Interrupted task sessions may require operator reconciliation; tools with uncertain
external outcomes are not automatically replayed.

See [backup and restore](backup-restore.md). Back up upload storage together with
PostgreSQL and test restoration into a disposable environment.
