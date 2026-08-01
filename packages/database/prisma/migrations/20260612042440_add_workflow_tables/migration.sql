-- DropForeignKey
ALTER TABLE "knowledge_inverted_index" DROP CONSTRAINT "knowledge_inverted_index_chunk_id_fkey";

-- DropForeignKey
ALTER TABLE "knowledge_inverted_index" DROP CONSTRAINT "knowledge_inverted_index_kb_id_fkey";

-- CreateTable
CREATE TABLE "agent_approvals" (
    "id" VARCHAR(36) NOT NULL,
    "session_id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36) NOT NULL,
    "step_number" INTEGER NOT NULL,
    "tool_name" VARCHAR(128) NOT NULL,
    "tool_args" JSONB NOT NULL,
    "risk_level" VARCHAR(20) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "approved_by" VARCHAR(36),
    "modified_args" JSONB,
    "rejection_reason" VARCHAR(500),
    "timeout_ms" INTEGER NOT NULL DEFAULT 300000,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_sessions" (
    "id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "audio_duration_sec" INTEGER NOT NULL DEFAULT 0,
    "asr_token_count" INTEGER NOT NULL DEFAULT 0,
    "tts_char_count" INTEGER NOT NULL DEFAULT 0,
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "voice" VARCHAR(32),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "voice_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" VARCHAR(36) NOT NULL,
    "user_id" VARCHAR(36) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" VARCHAR(36) NOT NULL,
    "workflow_id" VARCHAR(36) NOT NULL,
    "user_id" VARCHAR(36) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "checkpoint" JSONB,
    "current_step_id" VARCHAR(100),
    "progress" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_step_logs" (
    "id" VARCHAR(36) NOT NULL,
    "run_id" VARCHAR(36) NOT NULL,
    "step_id" VARCHAR(100) NOT NULL,
    "step_type" VARCHAR(50) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "tokens_used" INTEGER NOT NULL DEFAULT 0,
    "events" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_step_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_agent_approvals_session_id" ON "agent_approvals"("session_id");

-- CreateIndex
CREATE INDEX "ix_agent_approvals_status" ON "agent_approvals"("status");

-- CreateIndex
CREATE INDEX "ix_voice_sessions_conversation_id" ON "voice_sessions"("conversation_id");

-- CreateIndex
CREATE INDEX "ix_workflows_user_status" ON "workflows"("user_id", "status");

-- CreateIndex
CREATE INDEX "ix_workflows_user_id" ON "workflows"("user_id");

-- CreateIndex
CREATE INDEX "ix_workflow_runs_workflow" ON "workflow_runs"("workflow_id");

-- CreateIndex
CREATE INDEX "ix_workflow_runs_user_status" ON "workflow_runs"("user_id", "status");

-- CreateIndex
CREATE INDEX "ix_workflow_runs_started" ON "workflow_runs"("started_at");

-- CreateIndex
CREATE INDEX "ix_workflow_step_logs_run" ON "workflow_step_logs"("run_id");

-- CreateIndex
CREATE INDEX "ix_workflow_step_logs_run_step" ON "workflow_step_logs"("run_id", "step_id");

-- AddForeignKey
ALTER TABLE "knowledge_inverted_index" ADD CONSTRAINT "knowledge_inverted_index_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "knowledge_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_inverted_index" ADD CONSTRAINT "knowledge_inverted_index_kb_id_fkey" FOREIGN KEY ("kb_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workflow_step_logs" ADD CONSTRAINT "workflow_step_logs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
