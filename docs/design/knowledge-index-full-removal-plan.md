# Knowledge Index Full Removal Plan

> Status: Proposed
> Scope: Knowledge retrieval and ingestion only
> Data policy: Historical knowledge index data is not important and may be discarded.
> Goal: Fully remove legacy knowledge Milvus and PostgreSQL inverted-index dependencies from the active codebase.

## 1. Decision

The previous cleanup phase stopped writing new knowledge chunks to:

- Milvus knowledge collection.
- PostgreSQL `knowledge_inverted_index`.

That phase intentionally kept legacy schema, cleanup code, and rebuild helpers for rollback safety.

This follow-up phase can be more aggressive because the project accepts destructive reset and historical knowledge index data does not need to be preserved.

Target knowledge retrieval path remains:

```text
PGVector semantic recall + Elasticsearch keyword recall -> RRF fusion -> optional Reranker
```

Milvus remains in the project only for long-term memory through `MemoryEngine`.

## 2. Goals

- Remove all knowledge-specific Milvus code paths.
- Remove the `knowledge_chunks.milvus_id` column.
- Drop the `knowledge_inverted_index` table.
- Remove the Prisma `KnowledgeInvertedIndex` model and relations.
- Remove inverted-index rebuild and startup bootstrap logic.
- Keep PGVector embedding writes and search unchanged.
- Keep Elasticsearch indexing and keyword recall unchanged.
- Keep long-term memory Milvus behavior unchanged.

## 3. Non-Goals

This phase does not:

- Remove Milvus from the whole project.
- Remove `apps/server/src/services/milvus.ts`.
- Remove `@zilliz/milvus2-sdk-node`.
- Remove Milvus from Docker Compose.
- Change `MemoryEngine`.
- Remove PGVector.
- Remove Elasticsearch.
- Preserve historical knowledge Milvus vectors.
- Preserve historical `knowledge_inverted_index` rows.

## 4. Current Residual Dependencies

Static inspection shows these knowledge-index remnants remain after the minimal V3.5 cleanup:

- `apps/server/src/services/knowledge-ingestion.ts`
  - Imports `getMilvusClient`, `MILVUS_KNOWLEDGE_COLLECTION`, and `ensureKnowledgeCollection`.
  - Keeps `ensureCollection()` only for historical Milvus cleanup.
  - `deleteDocument()` reads `milvusId`, deletes historical Milvus vectors, and deletes `knowledgeInvertedIndex` rows.
  - Keeps `rebuildInvertedIndex()`.
- `apps/server/src/index.ts`
  - Counts `knowledgeInvertedIndex` on startup.
  - Rebuilds inverted index when chunks exist and index rows are empty.
- `apps/server/src/services/milvus.ts`
  - Exports `MILVUS_KNOWLEDGE_COLLECTION`.
  - Exports `ensureKnowledgeCollection()`.
- `packages/database/prisma/schema.prisma`
  - `KnowledgeChunk.milvusId`.
  - `KnowledgeInvertedIndex` model.
  - Relations from `KnowledgeBase` and `KnowledgeChunk` to `KnowledgeInvertedIndex`.
- `apps/server/src/modules/data-management/routes/knowledge.ts`
  - Chunk list endpoint serializes `milvusId`.
  - Some comments still describe PG + Milvus deletion.
  - Stats response uses a `milvus` field name even though `KnowledgeService.getCollectionStats()` now returns PGVector/ES stats.
- Tests still mock or assert legacy Milvus/inverted-index behavior.
- Docs still contain mixed historical descriptions.

## 5. Proposed Changes

### 5.1 Knowledge Ingestion Service

In `apps/server/src/services/knowledge-ingestion.ts`:

- Remove imports from `./milvus.js`.
- Remove private state:
  - `collectionLoaded`
  - `collectionLoadFailed`
- Remove private `ensureCollection()`.
- In `deleteDocument()`:
  - Query chunk IDs only.
  - Delete ES documents best-effort.
  - Delete PG chunks and document.
  - Do not read `milvusId`.
  - Do not call Milvus.
  - Do not call `knowledgeInvertedIndex.deleteMany()`.
- Remove `rebuildInvertedIndex()`.
- Remove `tokenize` import if it becomes unused.
- Update comments to say ingestion writes PG chunks, PGVector embeddings, and Elasticsearch documents.

### 5.2 Startup

In `apps/server/src/index.ts`:

- Remove startup block that counts and rebuilds `knowledgeInvertedIndex`.
- Keep seed knowledge base behavior unchanged.

### 5.3 Milvus Service

In `apps/server/src/services/milvus.ts`:

- Remove `MILVUS_KNOWLEDGE_COLLECTION`.
- Remove `ensureKnowledgeCollection()`.
- Keep:
  - `getMilvusClient()`
  - `MILVUS_MEMORY_COLLECTION`
  - `ensureMemoryCollection()`

### 5.4 Prisma Schema

In `packages/database/prisma/schema.prisma`:

- Remove `KnowledgeBase.invertedIndexEntries`.
- Remove `KnowledgeChunk.milvusId`.
- Remove `KnowledgeChunk.invertedIndexEntries`.
- Remove `KnowledgeInvertedIndex`.

Add a new destructive migration:

```sql
DROP TABLE IF EXISTS "knowledge_inverted_index";

ALTER TABLE "knowledge_chunks"
  DROP COLUMN IF EXISTS "milvus_id";
```

Because data is not important, no backfill, export, or compatibility migration is required.

### 5.5 API Cleanup

In `apps/server/src/modules/data-management/routes/knowledge.ts`:

- Update delete comments from `PG + Milvus` to `PG + Elasticsearch`.
- In chunk list endpoint, stop serializing `milvusId`.
- Rename stats response field from `milvus` to `retrieval` or `vector`.

Compatibility choice:

- Preferred: return only current fields and remove `milvusId`.
- Optional temporary compatibility: include `milvusId: null` for one release.

Given this project allows reset, prefer removing the field.

### 5.6 Tests

Update tests to match the new boundary:

- `knowledge-ingestion.test.ts`
  - Remove historical Milvus cleanup test.
  - Remove Milvus mock if no longer needed.
  - Remove `knowledgeInvertedIndex` mock where unused.
  - Add assertion that `deleteDocument()` does not call Milvus or inverted-index cleanup.
  - Keep assertions that ingestion writes PGVector and ES.
- `knowledge.test.ts`
  - Remove legacy Milvus and inverted-index mocks.
  - Keep search, RRF, dedupe, PGVector, and ES behavior tests.
- Add or update API test if route tests exist:
  - Chunk response does not contain `milvusId`.
  - Stats response exposes PGVector/ES-oriented field name.

### 5.7 Documentation

Update active docs:

- `docs/architecture/knowledge-hybrid-retrieval.md`
- `docs/architecture/knowledge-hybrid-retrieval-qa.md`
- `docs/server-services.md`
- `README.md`

Recommended wording:

```text
Knowledge retrieval uses PGVector for semantic recall and Elasticsearch for keyword recall.
Milvus is used only by long-term memory.
```

Historical design docs may remain if clearly marked as historical.

## 6. Execution Plan

1. Remove code-level knowledge Milvus and inverted-index references.
2. Add destructive Prisma migration.
3. Update Prisma schema.
4. Regenerate Prisma client.
5. Update tests and mocks.
6. Update active docs.
7. Run validation commands.
8. If local data exists, reset or migrate database.
9. Optionally drop the old Milvus knowledge collection manually.

## 7. Validation Plan

### Static Checks

Run:

```bash
git grep -n -e "knowledgeInvertedIndex" -e "KnowledgeInvertedIndex" -- apps/server/src packages/database/prisma
git grep -n -e "milvusId" -e "MILVUS_KNOWLEDGE_COLLECTION" -e "ensureKnowledgeCollection" -- apps/server/src packages/database/prisma
```

Expected:

- No production references to `knowledgeInvertedIndex`.
- No production references to `KnowledgeInvertedIndex`.
- No production references to `milvusId`.
- No production references to `MILVUS_KNOWLEDGE_COLLECTION`.
- No production references to `ensureKnowledgeCollection`.
- Memory-related Milvus references remain.

### Build and Tests

Run:

```bash
pnpm --filter @agentforge/database db:generate
pnpm --filter @agentforge/server typecheck
pnpm --filter @agentforge/server test
pnpm build
```

Expected:

- Prisma client generation succeeds.
- Server typecheck succeeds.
- Knowledge ingestion/search tests pass.
- Memory tests still pass.
- Full build succeeds.

### Runtime Smoke Tests

With PostgreSQL, Elasticsearch, and embedding provider available:

1. Start server.
2. Create or upload a knowledge document.
3. Confirm chunks are created in PostgreSQL.
4. Confirm `knowledge_chunks.embedding` is populated.
5. Confirm Elasticsearch index receives chunks when ES is available.
6. Search knowledge base and confirm result shape is unchanged for callers.
7. Stop Milvus and repeat knowledge ingestion/search.

Expected:

- Knowledge ingestion/search still works without Milvus.
- Long-term memory may degrade or fail according to its existing behavior if Milvus is stopped.
- Knowledge document deletion deletes PG and ES data without calling Milvus.

### Database Verification

After migration:

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'knowledge_chunks'
  AND column_name = 'milvus_id';

SELECT to_regclass('public.knowledge_inverted_index');
```

Expected:

- First query returns zero rows.
- Second query returns `NULL`.

## 8. Optional Destructive Reset

Because data is not important, the simplest local path is:

```bash
docker compose -f infra/docker/docker-compose.yml down -v
docker compose -f infra/docker/docker-compose.yml up -d
pnpm --filter @agentforge/database db:migrate
pnpm --filter @agentforge/database db:generate
```

This discards all local PostgreSQL, Milvus, Elasticsearch, Redis, MinIO, and related Docker volumes.

For a narrower reset, drop only PostgreSQL and Elasticsearch data, then rerun migrations and rebuild ES from PG after ingestion.

## 9. Optional Milvus Knowledge Collection Cleanup

After code no longer references the knowledge collection, old Milvus data can be removed manually.

If Milvus is running, drop:

```text
agentforge_knowledge
```

Do not drop:

```text
agentforge_memories
```

unless intentionally resetting memory data as well.

## 10. Rollback

Rollback is intentionally not optimized in this phase.

If the old knowledge Milvus or PG inverted-index path is needed again:

1. Reintroduce Prisma schema fields and model.
2. Add a migration recreating `knowledge_chunks.milvus_id` and `knowledge_inverted_index`.
3. Restore old ingestion write paths.
4. Restore old delete cleanup paths.
5. Rebuild from `knowledge_chunks.content` and `knowledge_chunks.embedding`.

Because historical data may be discarded, rollback means rebuilding indexes from the current primary PostgreSQL chunk data.

## 11. Acceptance Criteria

The cleanup is complete when:

- Knowledge ingestion contains no Milvus calls.
- Knowledge deletion contains no Milvus calls.
- Startup contains no inverted-index rebuild.
- Prisma schema has no `KnowledgeInvertedIndex`.
- Prisma schema has no `KnowledgeChunk.milvusId`.
- Database has no `knowledge_inverted_index` table.
- Database has no `knowledge_chunks.milvus_id` column.
- Knowledge search still uses PGVector + Elasticsearch + RRF.
- Knowledge search works when Milvus is unavailable.
- Long-term memory still uses Milvus as before.
- Tests and typecheck pass.

## 12. Recommended Boundary

Proceed with full removal for the knowledge subsystem.

Do not remove project-wide Milvus yet. The correct next independent decision is whether long-term memory should also migrate away from Milvus, likely to Mem0-only or PGVector-backed memory retrieval. That should be a separate design because it changes user memory behavior, not just knowledge indexing.
