CREATE TABLE "knowledge_inverted_index" (
    "id" VARCHAR(36) NOT NULL,
    "term" VARCHAR(255) NOT NULL,
    "chunk_id" VARCHAR(36) NOT NULL,
    "kb_id" VARCHAR(36) NOT NULL,
    "term_freq" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_inverted_index_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_inverted_index_term" ON "knowledge_inverted_index"("term");
CREATE INDEX "ix_inverted_index_chunk" ON "knowledge_inverted_index"("chunk_id");
CREATE INDEX "ix_inverted_index_kb_term" ON "knowledge_inverted_index"("kb_id", "term");

ALTER TABLE "knowledge_inverted_index"
  ADD CONSTRAINT "knowledge_inverted_index_chunk_id_fkey"
  FOREIGN KEY ("chunk_id") REFERENCES "knowledge_chunks"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "knowledge_inverted_index"
  ADD CONSTRAINT "knowledge_inverted_index_kb_id_fkey"
  FOREIGN KEY ("kb_id") REFERENCES "knowledge_bases"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
