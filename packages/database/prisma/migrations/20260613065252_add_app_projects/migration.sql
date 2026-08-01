-- AlterTable
ALTER TABLE "agent_sessions" ADD COLUMN     "compressed_summary" TEXT;

-- CreateTable
CREATE TABLE "video_sessions" (
    "id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "video_duration_sec" INTEGER NOT NULL DEFAULT 0,
    "audio_duration_sec" INTEGER NOT NULL DEFAULT 0,
    "asr_token_count" INTEGER NOT NULL DEFAULT 0,
    "tts_char_count" INTEGER NOT NULL DEFAULT 0,
    "vision_frames_count" INTEGER NOT NULL DEFAULT 0,
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "agent_config" JSONB,
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "video_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_projects" (
    "id" VARCHAR(36) NOT NULL,
    "user_id" VARCHAR(36) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
    "type" VARCHAR(32) NOT NULL DEFAULT 'frontend',
    "framework" VARCHAR(32) NOT NULL DEFAULT 'react',
    "preview_url" VARCHAR(500),
    "deploy_url" VARCHAR(500),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "app_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_files" (
    "id" VARCHAR(36) NOT NULL,
    "project_id" VARCHAR(36) NOT NULL,
    "path" VARCHAR(500) NOT NULL,
    "content" TEXT NOT NULL,
    "language" VARCHAR(32) NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_gen_runs" (
    "id" VARCHAR(36) NOT NULL,
    "project_id" VARCHAR(36) NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'running',
    "result" JSONB,
    "agent_session_id" VARCHAR(36),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "app_gen_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_video_sessions_conversation_id" ON "video_sessions"("conversation_id");

-- CreateIndex
CREATE INDEX "app_projects_user_id_updated_at_idx" ON "app_projects"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "project_files_project_id_idx" ON "project_files"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_files_project_id_path_key" ON "project_files"("project_id", "path");

-- CreateIndex
CREATE INDEX "app_gen_runs_project_id_idx" ON "app_gen_runs"("project_id");

-- CreateIndex
CREATE INDEX "ix_conversations_user_updated" ON "conversations"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "ix_messages_conversation_created" ON "messages"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "video_sessions" ADD CONSTRAINT "video_sessions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_projects" ADD CONSTRAINT "app_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_gen_runs" ADD CONSTRAINT "app_gen_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "app_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
