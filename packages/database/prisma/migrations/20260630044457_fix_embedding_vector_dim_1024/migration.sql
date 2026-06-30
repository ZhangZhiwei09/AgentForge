-- AlterColumn: fix embedding vector dimension from 1536 to 1024 (matching text-embedding-v3 / bge-m3 output)
ALTER TABLE "knowledge_chunks" ALTER COLUMN "embedding" TYPE vector(1024);
