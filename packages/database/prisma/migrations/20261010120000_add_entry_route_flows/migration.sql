CREATE TABLE "entry_route_flows" (
    "id" VARCHAR(36) PRIMARY KEY,
    "name" VARCHAR(200) NOT NULL,
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
    CONSTRAINT "entry_route_flows_enabled_published" CHECK (
        NOT enabled OR (published IS NOT NULL AND published_version > 0 AND NOT archived)
    ),
    CONSTRAINT "entry_route_flows_revisions" CHECK (
        draft_revision > 0 AND published_version >= 0
        AND published_revision >= 0 AND published_revision <= draft_revision
    )
);

CREATE UNIQUE INDEX "entry_route_flows_one_enabled"
    ON "entry_route_flows" ((true)) WHERE "enabled" = true;

CREATE TABLE "entry_route_flow_runs" (
    "id" VARCHAR(36) PRIMARY KEY,
    "flow_id" VARCHAR(36) NOT NULL REFERENCES "entry_route_flows" ("id") ON DELETE RESTRICT,
    "version" INTEGER NOT NULL,
    "draft_revision" INTEGER,
    "snapshot" JSONB NOT NULL,
    "actor_id" VARCHAR(36) NOT NULL,
    "conversation_id" VARCHAR(36),
    "assistant_message_id" VARCHAR(36),
    "test" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "input_summary" VARCHAR(2000) NOT NULL DEFAULT '',
    "records" JSONB NOT NULL DEFAULT '[]',
    "output" JSONB,
    "terminal_node_id" VARCHAR(100),
    "error" TEXT,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "entry_route_flow_runs_status" CHECK (
        status IN ('running', 'completed', 'failed', 'cancelled')
    )
);

CREATE INDEX "entry_route_flow_runs_flow_id_created_at_id_idx"
    ON "entry_route_flow_runs" ("flow_id", "created_at", "id");
CREATE INDEX "entry_route_flow_runs_conversation_id_idx"
    ON "entry_route_flow_runs" ("conversation_id");
