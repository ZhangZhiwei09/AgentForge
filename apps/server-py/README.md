# Python Backend

Python is the only public backend and ingestion worker. The retired TypeScript
API, BullMQ worker and Prisma runtime are no longer required. Public
authentication includes signup, signin, refresh rotation,
signout, current user and API key management. These use the existing PostgreSQL
`users`, `refresh_tokens` and `api_keys` tables; existing passwords and tokens are
supported. Signout revokes all refresh sessions for the authenticated user.
Existing access tokens remain valid until expiry.

Python also owns the entry-route flow management API and enterprise entry
decisions for authenticated and anonymous chat. The editor keeps its existing camelCase DTOs,
draft revisions, publication, activation, test runs and redacted audit records.
Signed-in chat applies safety and explicit controls first, resumes owned waiting
diagnoses, executes a published entry flow, then makes at most one business
classification call. Fixed replies do not need a model provider. Replies retain
entry provenance and clarification/diagnosis metadata in message history.
Public chat preserves the legacy anonymous actor, rejects supplied invalid
credentials, and resolves `conversation_id` before the old `session_id` alias.
Anonymous conversation lists require a session alias; V1 chat, deletion and
administration still require authentication. An absent reserved actor is created
without a password; existing actor credentials are preserved.

History supports full reads for legacy clients and explicit compound cursor
pagination for the current frontend. Citation and trace events retain their
payloads and final state in history, cleared drafts are replaced, and diagnosis
phases/waiting states use the frontend DTOs. Streams end with `[DONE]`; cancelled
requests finish saving emitted output and release their conversation locks.
Knowledge consultation uses the shared retrieval service described below.

Configured diagnosis runs reuse the existing Python flow runtime directly.
TASK chat and authenticated task APIs (`/api/agent/run`, `/respond`,
`/approve`, `/approvals` and `/api/agent-sessions`) now use the same ReAct graph
with durable session state and approval policy. Resumption preserves the session,
model, tool restrictions, budget and completed tool calls. Paused legacy TS
sessions can resume from their scratchpad. Approval arguments reach execution,
rejections never execute the tool, and conditional SQL writes prevent duplicate
resumption. Final task text is checked and masked before being emitted.
Interrupted tasks fail without replaying tools with uncertain external outcomes;
process death may leave a running session requiring operator reconciliation.
The root `pnpm dev` starts one Python API and both frontends.

Knowledge administration now supports base CRUD, document reads/deletion,
chunk reads/edits, preview and statistics. Base settings use snake_case;
document/chunk DTOs retain camelCase and document processing timestamps.
Partial settings updates validate the merged configuration. Preview reuses the
ingestion splitter with fixed separators, explicit zero overlap and parent/child
chunks. Chunk edits require a finite 1024-dimensional embedding and commit it
with the text; provider failures preserve the existing chunk. Elasticsearch
sync is optional through `ELASTICSEARCH_URL`; failures are logged and SQL remains
authoritative. All knowledge administration, retrieval, evaluation and ingest endpoints
require authentication.

Document creation, batches, multipart upload and explicit processing use a shared
Python ingestion pipeline. Upload with `?process=false` preserves a pending
document until `/api/knowledge/bases/{id}/process` is called, allowing the editor
to save settings first. The pipeline extracts PDF text, DOCX paragraphs/tables,
UTF-8 text and images through the existing vision provider. Encrypted/scanned
PDFs, legacy `.doc` files (convert to `.docx`) and extraction failures retain
their error status. Uploads are limited to 15 MB. Binary originals use
`KNOWLEDGE_STORAGE_ROOT` (retaining the old server storage path for existing installations) or the
existing MinIO credentials. Existing absolute local paths and MinIO object keys
remain readable. Chunk replacement is atomic; failed retries preserve old chunks.

Processing is synchronous by default. Set `INGESTION_ASYNC_ENABLED=true` and
`REDIS_URL` to use the durable ARQ queue, then run a separate worker from this
directory:

```powershell
uv run python -m src.worker
```

Queue outages return 503 while retaining the pending document. Jobs retry
transient failures at most three times; SQL claims prevent overlapping workers.
An expired claim can be recovered after `INGESTION_LEASE_SECONDS` (at least the
job timeout plus 30 seconds). Redis persistence must be enabled for restart
durability. Failed or expired documents can be dispatched again through the
ingestion service; the bulk process endpoint selects pending documents.

From this directory:

```powershell
uv sync
uv run python -m src.dev
```

The public Python entry defaults to port `8000`. If occupied, select another:

```powershell
uv run python -m src.dev --public --port 8006 --no-reload
```

Configuration precedence is process environment, `apps/server-py/.env`, root
`.env`, then `apps/server/.env` as a temporary migration fallback. The Python
entry can run with only its own configuration; it does not contact the Node
server. `DATABASE_URL` accepts PostgreSQL URLs and is normalized to `asyncpg`.
Use `JWT_SECRET` matching existing credentials when retaining user sessions.
Set `CORS_ORIGINS` to a comma-separated list of frontend origins; an empty value
disables cross-origin access.

`pnpm server:dev`, `pnpm py:dev` and `pnpm py:api` all start the public API.
`--public` remains a compatibility alias; `--flow-service` explicitly selects
the former 8004 port. The worker uses the same local configuration precedence.

Focused validation:

```powershell
uv run pytest -p no:cacheprovider tests/test_auth.py tests/test_auth_api.py tests/test_platform_dev.py tests/test_config.py
uv run pytest -p no:cacheprovider tests/test_entry_flows.py tests/test_entry_flow_api.py tests/test_entry_decision.py tests/test_business_classifier.py tests/test_entry_chat_api.py
uv run pytest -p no:cacheprovider tests/test_chat_compatibility.py tests/test_conversation_history.py
uv run pytest -p no:cacheprovider tests/test_agent_tasks_api.py
uv run pytest -p no:cacheprovider tests/test_knowledge_management_api.py tests/test_rag_splitter.py
uv run pytest -p no:cacheprovider tests/test_knowledge_ingestion_api.py
```

HTTP authentication and entry/chat tests create isolated SQLite databases.
They never migrate or modify the configured business PostgreSQL database.
Real browser fixtures require an explicit `AGENTFORGE_E2E_DATABASE_URL` pointing
to `agentforge_test_*`, plus the API's `JWT_SECRET`. See the root development
guide for independent API/frontend and deterministic embedding acceptance.

Task, entry-flow and knowledge HTTP tests can also use a disposable PostgreSQL
database. Set `AGENTFORGE_TEST_POSTGRES_URL` to an asyncpg URL whose database is
`agentforge_python_migration` or starts with `agentforge_test_`, with the `vector`
extension installed. Each test creates and drops its own uniquely named schema;
existing tables and the public schema are preserved.
Set `AGENTFORGE_TEST_REDIS_URL` to an isolated Redis instance to additionally
exercise actual ARQ enqueue/worker consumption with a unique test queue.

Retrieval now combines pgvector cosine recall and Elasticsearch keyword recall
with reciprocal rank fusion (k=60), bigram deduplication, optional HTTP reranking
and parent chunk context. Elasticsearch failures use SQL substring matching;
dense failures can still return keyword results. SQL revalidates index hits and
excludes disabled bases/documents/chunks, missing chunks and parent-only chunks.
Set `PGVECTOR_ENABLED=true` with the existing 1024-dimensional embedding model.
OpenAI text-embedding-3 models explicitly request 1024 dimensions; custom models
must return the retained schema's dimension.
Optional `RERANKER_BASE_URL` and `RERANKER_MODEL` enable the existing `/rerank`
wire contract with a five-second timeout; unavailable or invalid responses use
fused ranking. RRF scores are ranks, not relevance probabilities.

`/api/knowledge/search`, base `/hit-testing` and the regression test-set, case,
run/history/metrics APIs retain the editor contracts. Regression runs persist
retrieval/prompt snapshots, assertions and latency in the existing tables.
Metrics preserve binary Recall@K, fixed-K Precision, MRR and binary NDCG;
prompt snapshots use Chinese. Interrupted runs are marked failed. Focused tests:

```powershell
uv run pytest -p no:cacheprovider tests/test_knowledge_retrieval_api.py tests/test_rag_pgvector.py
```

Chat consultation preloads ranked knowledge through the shared retrieval
service, then uses the same persisted task graph as `/api/agent/run`. Tool
search uses that service too; document-level fallback that bypassed chunk
state has been removed. Numbered citation cards retain real document IDs and
score types. Sentence support uses embeddings with a keyword fallback, removes
unknown citation indexes and marks weakly supported claims before text is sent.
Internal decision JSON is filtered before output.

Chat task pauses persist their model, budgets, messages and tool outcomes.
Follow-up messages resume the same ask-user task; mutations require the same
approval API as standalone tasks. Explicit cancellation revokes a paused task's
pending approvals. Chat owns one assistant message per request and saves
citations, trace updates and the task session reference in history. Model
disconnects mark running tasks failed without replaying uncertain tool effects.
Focused validation: `tests/test_chat_tasks_api.py` and `tests/test_agent_tasks_api.py`.

Ratings, FAQ, feedback and analytics now use the existing SQL tables. Ratings
validate conversation ownership and assistant message membership; failed writes
return an error. Public FAQ excludes disabled bases, documents and chunks.
Feedback, analytics, tool definitions, disabled-memory endpoints and Prometheus
metrics require authentication. `/api/ready` checks SQL, provider configuration
and Redis, requiring Redis when asynchronous ingestion is enabled.

The public `/api/diagnosis/query` adapter retains the original response DTO,
checks missing information before model invocation and uses the existing Python
diagnosis runtime with request-scoped knowledge retrieval. Tool, routing,
citation and HTTP metrics are recorded along their actual execution paths;
HTTP metric labels use route templates. Focused tests:
`tests/test_platform_api.py`.

Python owns database bootstrap and upgrades. From this directory:

```powershell
uv run python -m src.database upgrade
uv run python -m src.database check
uv run python -m src.database create-admin --email admin@agentforge.local
```

`create-admin` prompts for a password or reads `AGENTFORGE_ADMIN_PASSWORD`.
It never resets an existing administrator password or promotes an existing
ordinary user. No default privileged credentials are seeded.

`upgrade` creates a fresh pgvector schema from frozen versioned DDL, or adopts
compatible existing Prisma/Alembic tables in one transaction. It checks columns,
types and primary keys, creates missing tables/indexes and records the Python
baseline. Incompatible existing columns require an explicit repair migration;
the command does not drop data or resize existing embeddings. Historical
Alembic revisions remain readable. Use this command for initial bootstrap;
the old Alembic chain alone depended on externally created Prisma tables.
All existing business and retained workflow/team tables are registered in
SQLAlchemy. PostgreSQL bootstrap/adoption tests: `tests/test_database.py`.

The shared registry exposes knowledge search, time and calculation by default.
Each execution binds a server-owned actor, conversation, run and effective
policy. `AGENT_ALLOWED_TOOLS` can restrict available tools. Web search/fetch,
general HTTP requests, file read/write/search, raw SQL and support-ticket
creation remain disabled at dispatch, even if added to that setting. Setting
`FILE_WORKSPACE` or `TAVILY_API_KEY` does not re-enable these adapters; scoped
adapters and their authorization boundaries need separate implementation.

Task limits default to `AGENT_MAX_TOKENS=50000`,
`AGENT_MAX_COST_CENTS=200` and `AGENT_MAX_ITERATIONS=20`. Client requests can
only tighten these limits, and resumes preserve stricter saved limits and
usage. An explicit `tools=[]` grants no tools. PII and content filters are
mandatory for task execution. These limits do not yet provide complete
cumulative accounting across diagnosis agents or evaluation runs.

Streaming usage includes terminal usage-only frames and preserves reported
zero counts. Missing usage is estimated and labeled separately. CHAT and TASK
completion events carry usage; persisted task records retain per-call reported,
estimated or reserved totals. A model call reserves its estimated input and
maximum output in the task runtime before dispatch. Interrupted calls retain
that conservative amount with `uncertain=true`; they are not silently treated
as free. Successful usage is saved before response parsing. Cost values use the
versioned internal `legacy-estimate-v1` rate table, including a labeled fallback
for unknown models; they are estimates, not provider invoices.

Observability input/output/metadata copies are recursively redacted and bounded.
The API and worker redact common credentials and personal identifiers in log
messages and exception chains. Uvicorn access logs retain their formatter
contract and omit URL query parameters. Connection logs expose only scheme/host/port;
tool output previews are omitted. Original tool inputs and application data are
unchanged. Langfuse uses sanitized updates and balanced context lifecycles.
Regression tests: `tests/test_observability_privacy.py` and
`tests/test_usage_metering.py`.

`MONITORING_MODE=disabled` is the default: real monitoring is not integrated,
so diagnosis reports unavailable evidence. Local demonstrations may explicitly
set `MONITORING_MODE=mock`; known demo traces are marked as simulated and
unknown traces return `not_found`, without replacement evidence. Production
rejects mock mode. Existing flows that depend on unavailable tools fail
validation or execution until their capabilities are supported.

Mutation-risk tools require approval regardless of their optional approval
flag; transient diagnosis graphs cannot perform those mutations. Tools open a
shared circuit after five failures, then allow one recovery probe after sixty
seconds. Policy regressions: `tests/test_execution_policy.py` and
`tests/test_diagnosis_policy.py`.

HTTP moving-window limits default to 60 requests per minute per peer address.
Configure `RATE_LIMIT_MAX`, `RATE_LIMIT_ENABLED` and
`RATE_LIMIT_REDIS_ENABLED` (uses `REDIS_URL` for shared limits). Redis outages
temporarily use local limits. Health/readiness probes are exempt; SSE streams
are forwarded without buffering. Forwarded client addresses must be supplied by
a trusted proxy configured for Uvicorn, not arbitrary client headers.
Entry decisions also retain SQL classification audit records. Focused tests:
`tests/test_operational_tools.py`.
