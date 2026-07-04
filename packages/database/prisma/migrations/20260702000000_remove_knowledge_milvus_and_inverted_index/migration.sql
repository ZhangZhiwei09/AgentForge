-- Drop the inverted index table
DROP TABLE IF EXISTS "knowledge_inverted_index";

-- Remove the milvus_id column from knowledge_chunks
ALTER TABLE "knowledge_chunks"
  DROP COLUMN IF EXISTS "milvus_id";
