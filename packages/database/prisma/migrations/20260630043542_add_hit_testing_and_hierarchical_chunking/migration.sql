-- AlterTable
ALTER TABLE "knowledge_bases" ADD COLUMN     "child_chunk_overlap_tokens" INTEGER,
ADD COLUMN     "child_chunk_size_tokens" INTEGER,
ADD COLUMN     "chunk_structure" VARCHAR(20) DEFAULT 'paragraph',
ADD COLUMN     "custom_separator" VARCHAR(100),
ADD COLUMN     "remove_extra_spaces" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "remove_urls_emails" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "separator_mode" VARCHAR(20) DEFAULT 'auto';

-- AlterTable
ALTER TABLE "knowledge_chunks" ADD COLUMN     "parent_chunk_id" VARCHAR(36);

-- AlterTable
ALTER TABLE "knowledge_documents" ADD COLUMN     "chunking_completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "downloading_completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "embedding_completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "normalizing_completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "parsing_completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "processing_detail" TEXT,
ADD COLUMN     "processing_started_at" TIMESTAMPTZ(6),
ALTER COLUMN "status" SET DATA TYPE VARCHAR(50);

-- CreateTable
CREATE TABLE "knowledge_query_logs" (
    "id" VARCHAR(36) NOT NULL,
    "kb_id" VARCHAR(36) NOT NULL,
    "query" VARCHAR(1000) NOT NULL,
    "method" VARCHAR(20) NOT NULL DEFAULT 'hybrid',
    "results" INTEGER NOT NULL DEFAULT 0,
    "source" VARCHAR(20) NOT NULL DEFAULT 'hit_testing',
    "elapsed_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_query_log_kb" ON "knowledge_query_logs"("kb_id");

-- CreateIndex
CREATE INDEX "ix_query_log_created" ON "knowledge_query_logs"("created_at");

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_parent_chunk_id_fkey" FOREIGN KEY ("parent_chunk_id") REFERENCES "knowledge_chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
