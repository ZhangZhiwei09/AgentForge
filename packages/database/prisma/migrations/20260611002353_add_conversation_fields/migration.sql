-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "customer_meta" JSONB,
ADD COLUMN     "intent" VARCHAR(100),
ADD COLUMN     "rating" VARCHAR(20),
ADD COLUMN     "status" VARCHAR(20) DEFAULT 'active';

-- AlterTable
ALTER TABLE "knowledge_bases" ADD COLUMN     "category" VARCHAR(100);

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36) NOT NULL,
    "task" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "scratchpad" JSONB NOT NULL DEFAULT '[]',
    "final_summary" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "satisfaction_ratings" (
    "id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36) NOT NULL,
    "message_id" VARCHAR(36),
    "rating" VARCHAR(20) NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "satisfaction_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_agent_sessions_conversation_id" ON "agent_sessions"("conversation_id");

-- CreateIndex
CREATE INDEX "ix_satisfaction_ratings_conversation_id" ON "satisfaction_ratings"("conversation_id");

-- AddForeignKey
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "satisfaction_ratings" ADD CONSTRAINT "satisfaction_ratings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
