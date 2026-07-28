-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "type" VARCHAR(20) NOT NULL DEFAULT 'text';

-- CreateTable
CREATE TABLE "conversation_memory" (
    "id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36) NOT NULL,
    "summary" TEXT,
    "covered_until_message_id" VARCHAR(36),
    "token_count" INTEGER NOT NULL DEFAULT 0,
    "memory_type" VARCHAR(20) NOT NULL DEFAULT 'summary',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_memory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_conversation_memory_type" ON "conversation_memory"("memory_type");

-- CreateIndex
CREATE UNIQUE INDEX "ix_conversation_memory_conv_id" ON "conversation_memory"("conversation_id");

-- AddForeignKey
ALTER TABLE "conversation_memory" ADD CONSTRAINT "conversation_memory_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
