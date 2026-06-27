-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";

-- AlterTable
ALTER TABLE "knowledge_chunks" ADD COLUMN     "embedding" vector(1536);

-- CreateTable
CREATE TABLE "knowledge_graph_entities" (
    "id" VARCHAR(36) NOT NULL,
    "name" VARCHAR(500) NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "kb_id" VARCHAR(36) NOT NULL,
    "doc_ids" TEXT[],
    "aliases" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_graph_entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_graph_relations" (
    "id" VARCHAR(36) NOT NULL,
    "from_entity_id" VARCHAR(36) NOT NULL,
    "to_entity_id" VARCHAR(36) NOT NULL,
    "rel_type" VARCHAR(100) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source_chunk_id" VARCHAR(36) NOT NULL,
    "doc_id" VARCHAR(36) NOT NULL,
    "evidence" VARCHAR(2000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_graph_relations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_knowledge_graph_entities_kb_id" ON "knowledge_graph_entities"("kb_id");

-- CreateIndex
CREATE INDEX "ix_knowledge_graph_entities_type" ON "knowledge_graph_entities"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ix_knowledge_graph_entities_name_type" ON "knowledge_graph_entities"("name", "type");

-- CreateIndex
CREATE INDEX "ix_kg_relations_from" ON "knowledge_graph_relations"("from_entity_id");

-- CreateIndex
CREATE INDEX "ix_kg_relations_to" ON "knowledge_graph_relations"("to_entity_id");

-- CreateIndex
CREATE INDEX "ix_kg_relations_chunk" ON "knowledge_graph_relations"("source_chunk_id");

-- CreateIndex
CREATE INDEX "ix_kg_relations_doc" ON "knowledge_graph_relations"("doc_id");
