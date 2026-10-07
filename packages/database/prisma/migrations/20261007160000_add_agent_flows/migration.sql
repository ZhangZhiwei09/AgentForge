CREATE TABLE "agent_flows" (
    "id" VARCHAR(36) PRIMARY KEY,
    "name" VARCHAR(200) NOT NULL,
    "scene" VARCHAR(30) NOT NULL DEFAULT 'diagnosis',
    "draft" JSONB NOT NULL,
    "draft_revision" INTEGER NOT NULL DEFAULT 1,
    "published" JSONB,
    "published_version" INTEGER NOT NULL DEFAULT 0,
    "published_revision" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "updated_by" VARCHAR(36) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_flows_enabled_published" CHECK (
        NOT enabled OR (published IS NOT NULL AND NOT archived)
    )
);

CREATE UNIQUE INDEX "agent_flows_one_enabled_scene"
    ON "agent_flows" ("scene") WHERE "enabled" = true;

CREATE TABLE "agent_flow_runs" (
    "id" VARCHAR(36) PRIMARY KEY,
    "flow_id" VARCHAR(36) NOT NULL REFERENCES "agent_flows" ("id") ON DELETE RESTRICT,
    "version" INTEGER NOT NULL,
    "draft_revision" INTEGER,
    "snapshot" JSONB NOT NULL,
    "actor_id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36),
    "test" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(30) NOT NULL DEFAULT 'running',
    "records" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB,
    "error" TEXT,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "agent_flow_runs_flow_id_created_at_idx" ON "agent_flow_runs" ("flow_id", "created_at");
CREATE INDEX "agent_flow_runs_conversation_id_status_idx" ON "agent_flow_runs" ("conversation_id", "status");
CREATE UNIQUE INDEX "agent_flow_runs_one_waiting_conversation"
    ON "agent_flow_runs" ("conversation_id") WHERE "status" = 'waiting_input' AND "test" = false;
