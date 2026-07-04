CREATE TABLE "knowledge_regression_test_sets" (
    "id" VARCHAR(36) NOT NULL,
    "kb_id" VARCHAR(36) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_regression_test_sets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_regression_cases" (
    "id" VARCHAR(36) NOT NULL,
    "test_set_id" VARCHAR(36) NOT NULL,
    "kb_id" VARCHAR(36) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "query" VARCHAR(1000) NOT NULL,
    "expected_top_k" INTEGER NOT NULL DEFAULT 5,
    "min_score" DOUBLE PRECISION,
    "search_method" VARCHAR(20) NOT NULL DEFAULT 'hybrid',
    "top_k" INTEGER NOT NULL DEFAULT 10,
    "reranking_enable" BOOLEAN NOT NULL DEFAULT true,
    "score_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expected_doc_titles" JSONB NOT NULL DEFAULT '[]',
    "expected_doc_ids" JSONB NOT NULL DEFAULT '[]',
    "required_text" JSONB NOT NULL DEFAULT '[]',
    "forbidden_text" JSONB NOT NULL DEFAULT '[]',
    "prompt_required_context_text" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_regression_cases_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_regression_runs" (
    "id" VARCHAR(36) NOT NULL,
    "test_set_id" VARCHAR(36) NOT NULL,
    "kb_id" VARCHAR(36) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'running',
    "total_cases" INTEGER NOT NULL DEFAULT 0,
    "passed_cases" INTEGER NOT NULL DEFAULT 0,
    "failed_cases" INTEGER NOT NULL DEFAULT 0,
    "hit_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "average_rank" DOUBLE PRECISION,
    "average_elapsed_ms" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "knowledge_regression_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "knowledge_regression_run_items" (
    "id" VARCHAR(36) NOT NULL,
    "run_id" VARCHAR(36) NOT NULL,
    "case_id" VARCHAR(36) NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "rank" INTEGER,
    "score" DOUBLE PRECISION,
    "matched_doc_id" VARCHAR(36),
    "failure_reason" VARCHAR(2000),
    "results_snapshot" JSONB NOT NULL DEFAULT '[]',
    "prompt_snapshot" TEXT,
    "elapsed_ms" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_regression_run_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ix_regression_test_sets_kb" ON "knowledge_regression_test_sets"("kb_id");
CREATE INDEX "ix_regression_cases_test_set" ON "knowledge_regression_cases"("test_set_id");
CREATE INDEX "ix_regression_cases_kb" ON "knowledge_regression_cases"("kb_id");
CREATE INDEX "ix_regression_runs_test_set" ON "knowledge_regression_runs"("test_set_id");
CREATE INDEX "ix_regression_runs_kb" ON "knowledge_regression_runs"("kb_id");
CREATE INDEX "ix_regression_runs_created" ON "knowledge_regression_runs"("created_at");
CREATE INDEX "ix_regression_run_items_run" ON "knowledge_regression_run_items"("run_id");
CREATE INDEX "ix_regression_run_items_case" ON "knowledge_regression_run_items"("case_id");

ALTER TABLE "knowledge_regression_cases"
  ADD CONSTRAINT "knowledge_regression_cases_test_set_id_fkey"
  FOREIGN KEY ("test_set_id") REFERENCES "knowledge_regression_test_sets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_regression_runs"
  ADD CONSTRAINT "knowledge_regression_runs_test_set_id_fkey"
  FOREIGN KEY ("test_set_id") REFERENCES "knowledge_regression_test_sets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_regression_run_items"
  ADD CONSTRAINT "knowledge_regression_run_items_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "knowledge_regression_runs"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "knowledge_regression_run_items"
  ADD CONSTRAINT "knowledge_regression_run_items_case_id_fkey"
  FOREIGN KEY ("case_id") REFERENCES "knowledge_regression_cases"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
