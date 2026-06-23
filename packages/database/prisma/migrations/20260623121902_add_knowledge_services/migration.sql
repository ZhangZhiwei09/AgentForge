-- AlterTable
ALTER TABLE "knowledge_chunks" ADD COLUMN     "quality_label" VARCHAR(20),
ADD COLUMN     "source_type" VARCHAR(20);

-- AlterTable
ALTER TABLE "knowledge_documents" ADD COLUMN     "error_message" VARCHAR(2000),
ADD COLUMN     "original_file_path" VARCHAR(1000),
ADD COLUMN     "original_file_size" INTEGER,
ADD COLUMN     "original_file_type" VARCHAR(100),
ADD COLUMN     "original_filename" VARCHAR(500),
ADD COLUMN     "quality_label" VARCHAR(20),
ADD COLUMN     "retry_count" INTEGER NOT NULL DEFAULT 0;
