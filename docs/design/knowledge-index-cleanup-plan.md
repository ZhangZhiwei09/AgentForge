# Knowledge Index Cleanup Plan

> Status: Implemented (V3.5)
> Scope: Knowledge ingestion only
> Goal: Stop maintaining unused knowledge Milvus and PostgreSQL inverted-index writes with the smallest safe change.

## 1. Background

The knowledge retrieval path has already moved to:

```text
PGVector semantic recall + Elasticsearch keyword recall -> RRF fusion -> optional Reranker
```

Current code still keeps two legacy write paths during knowledge ingestion:

- Milvus knowledge collection writes.
- PostgreSQL `knowledge_inverted_index` writes.

These paths are not part of the current knowledge search path. Keeping them increases ingestion latency, operational coupling, and failure surface.

Milvus is still used by long-term memory through `MemoryEngine`, so this plan does not remove Milvus from the whole project.

## 2. Goal

Reduce knowledge ingestion complexity while preserving runtime behavior for search and memory:

- Stop writing new knowledge chunks to Milvus.
- Stop writing new knowledge chunks to PostgreSQL inverted index.
- Keep PGVector embedding writes.
- Keep Elasticsearch indexing.
- Keep long-term memory Milvus behavior unchanged.
- Avoid destructive schema changes in the first phase.

## 3. Non-Goals

This phase does not:

- Delete `apps/server/src/services/milvus.ts`.
- Remove Milvus from `MemoryEngine`.
- Remove Milvus from Docker Compose.
- Drop `knowledge_chunks.milvus_id`.
- Drop `knowledge_inverted_index`.
- Remove the Prisma `KnowledgeInvertedIndex` model.
- Change `KnowledgeService.searchHybrid()`.
- Change PGVector, Elasticsearch, RRF, or Reranker behavior.

## 4. Change Boundary

Primary target:

- `apps/server/src/services/knowledge-ingestion.ts`

Expected minimal changes:

- In `ingestChunks()`:
  - Remove the required `ensureKnowledgeCollection()` call for knowledge ingestion.
  - Remove Milvus client insertion into `MILVUS_KNOWLEDGE_COLLECTION`.
  - Create `KnowledgeChunk` records without `milvusId`, or leave it null.
  - Remove `knowledgeInvertedIndex.createMany()` writes for new chunks.
  - Keep PG `KnowledgeChunk` creation.
  - Keep PGVector `embedding` update.
  - Keep Elasticsearch bulk indexing.
- In `deleteDocument()`:
  - Prefer preserving existing cleanup behavior for historical Milvus and inverted-index data in the first phase.
  - New documents will have no Milvus IDs and no inverted-index rows, so cleanup becomes a no-op for those paths.
- Documentation:
  - Update comments and architecture docs that still describe knowledge Milvus or PG inverted index as active write targets.
- Tests:
  - Add or update tests to assert knowledge ingestion no longer depends on Milvus and no longer writes inverted-index rows.

## 5. Impact Scope

### Knowledge Upload and Ingestion

Expected impact:

- New documents no longer fail because Milvus is unavailable.
- Ingestion does less work per chunk.
- PGVector embedding remains the source for semantic recall.
- Elasticsearch remains the source for keyword recall.

### Knowledge Search

Expected impact:

- No behavior change.
- Search still uses PGVector and Elasticsearch with RRF fusion.
- ES unavailable behavior remains dense-only fallback via PGVector.

### Document Deletion

Expected impact:

- Historical Milvus and inverted-index cleanup can continue to run.
- New documents have no Milvus vectors or inverted-index entries, so those cleanup branches should be harmless no-ops.

### Long-Term Memory

Expected impact:

- No behavior change.
- `MemoryEngine` continues using Milvus for semantic memory search.
- Mem0 fallback behavior remains unchanged.

### Deployment

Expected impact:

- Milvus still remains in local and production compose files because memory may depend on it.
- Elasticsearch and PostgreSQL remain required for full knowledge retrieval.

## 6. Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Hidden caller depends on `knowledge_inverted_index` for keyword search | Keyword fallback behavior may disappear | Code search currently shows no active query path. Keep schema and model in phase 1 so rollback is simple. |
| Need to roll back to old Milvus-based knowledge search | New chunks have no Milvus vectors | Rebuild from `knowledge_chunks.embedding` if rollback is required. |
| Existing delete logic assumes `milvusId` exists | Runtime errors during delete | Keep null checks and no-op behavior for empty Milvus ID list. |
| Documentation drift | Operators may misunderstand active dependencies | Update design docs and comments in the same change. |

## 7. Rollback Plan

Because phase 1 keeps schema and service files intact, rollback is straightforward:

1. Restore Milvus insert logic in `ingestChunks()`.
2. Restore PostgreSQL inverted-index write logic in `ingestChunks()`.
3. Run the inverted-index rebuild helper if needed.
4. Rebuild Milvus knowledge vectors from existing PG chunk embeddings if old knowledge Milvus search is needed.

## 8. Acceptance Criteria

The change is accepted when all of the following are true:

- New knowledge document ingestion succeeds when Milvus is stopped or unreachable.
- New knowledge chunks are created in PostgreSQL.
- `knowledge_chunks.embedding` is populated through PGVector.
- Elasticsearch indexing still runs when ES is available.
- Knowledge search returns the same response shape as before.
- New ingestion does not create `knowledge_inverted_index` rows.
- New ingestion leaves `knowledge_chunks.milvus_id` null.
- Existing document deletion still succeeds.
- Long-term memory tests and behavior are unchanged.
- Relevant knowledge ingestion/search tests pass.

## 9. Suggested Implementation Order

1. Remove knowledge Milvus and inverted-index writes from `ingestChunks()`.
2. Keep historical cleanup behavior in `deleteDocument()`.
3. Update comments and docs to describe the active storage paths.
4. Add focused tests for Milvus-unavailable ingestion and no inverted-index writes.
5. Run server tests covering knowledge, RRF, and memory.

## 10. Later Cleanup Phase

Only after this phase is stable:

- Drop `knowledge_chunks.milvus_id`.
- Drop `knowledge_inverted_index`.
- Remove `KnowledgeInvertedIndex` from Prisma schema.
- Remove unused rebuild helpers.
- Revisit Docker Milvus only if long-term memory has fully migrated away from Milvus.

## 11. Implementation Notes (2026-07-01)

Implemented in V3.5. Changes:

- `knowledge-ingestion.ts`: Removed Milvus `insert()` and PG `knowledgeInvertedIndex.createMany()` from `ingestChunks()`. Removed `milvusId` from `KnowledgeChunk.create()` data.
- `deleteDocument()`: Preserved Milvus + inverted-index cleanup for historical data (guarded by null checks — no-op for new docs).
- `ensureCollection()`: Retained for legacy `deleteDocument()` path.
- `rebuildInvertedIndex()` and `rebuildESIndex()`: Retained as static helpers.
- Tests: `__tests__/knowledge-ingestion.test.ts` — 10 tests covering Milvus-free ingestion, no inverted-index writes, PGVector/ES preservation, hierarchical chunk path, and historical delete cleanup.
- Docs: Updated `docs/architecture/knowledge-hybrid-retrieval-qa.md` and `knowledge-hybrid-retrieval.md`.
