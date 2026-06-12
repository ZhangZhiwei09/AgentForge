-- CreateTable
CREATE TABLE "agent_teams" (
    "id" VARCHAR(36) NOT NULL,
    "user_id" VARCHAR(36) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "definition" JSONB NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "last_run_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_team_runs" (
    "id" VARCHAR(36) NOT NULL,
    "team_id" VARCHAR(36) NOT NULL,
    "user_id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36),
    "task" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "mode" VARCHAR(20) NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "blackboard" JSONB NOT NULL DEFAULT '{}',
    "checkpoint" JSONB,
    "output" JSONB,
    "error" TEXT,
    "rounds_count" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "agent_team_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_teams_user_id_idx" ON "agent_teams"("user_id");

-- CreateIndex
CREATE INDEX "agent_teams_status_idx" ON "agent_teams"("status");

-- CreateIndex
CREATE INDEX "agent_teams_updated_at_idx" ON "agent_teams"("updated_at");

-- CreateIndex
CREATE INDEX "agent_team_runs_team_id_idx" ON "agent_team_runs"("team_id");

-- CreateIndex
CREATE INDEX "agent_team_runs_user_id_idx" ON "agent_team_runs"("user_id");

-- CreateIndex
CREATE INDEX "agent_team_runs_status_idx" ON "agent_team_runs"("status");

-- CreateIndex
CREATE INDEX "agent_team_runs_started_at_idx" ON "agent_team_runs"("started_at");

-- AddForeignKey
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_team_runs" ADD CONSTRAINT "agent_team_runs_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "agent_teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_team_runs" ADD CONSTRAINT "agent_team_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
