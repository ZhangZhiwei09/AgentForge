-- CreateTable
CREATE TABLE "intent_samples" (
    "id" VARCHAR(36) NOT NULL,
    "route" VARCHAR(20) NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "embedding" vector(1024),
    "source" VARCHAR(20) NOT NULL DEFAULT 'manual',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_classification_logs" (
    "id" VARCHAR(36) NOT NULL,
    "session_id" VARCHAR(64),
    "conversation_id" VARCHAR(36),
    "user_message" VARCHAR(2000) NOT NULL,
    "route" VARCHAR(20) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "top_matches" JSONB,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_classification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_intent_samples_route" ON "intent_samples"("route");

-- CreateIndex
CREATE INDEX "ix_intent_samples_active" ON "intent_samples"("active");

-- CreateIndex
CREATE INDEX "ix_route_classification_log_source" ON "route_classification_logs"("source");

-- CreateIndex
CREATE INDEX "ix_route_classification_log_route" ON "route_classification_logs"("route");

-- CreateIndex
CREATE INDEX "ix_route_classification_log_session" ON "route_classification_logs"("session_id");

-- CreateIndex
CREATE INDEX "ix_route_classification_log_created" ON "route_classification_logs"("created_at");
