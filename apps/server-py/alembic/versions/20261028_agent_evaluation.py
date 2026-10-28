"""Add durable Agent evaluation suites and run snapshots."""

from alembic import op

revision = "20261028_agent_evaluation"
down_revision = "20261013_support_tickets"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_evaluation_suites (
            id varchar(36) PRIMARY KEY,
            name varchar(255) NOT NULL,
            description text,
            version varchar(32) NOT NULL DEFAULT '1',
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_evaluation_cases (
            id varchar(36) PRIMARY KEY,
            suite_id varchar(36) NOT NULL REFERENCES agent_evaluation_suites(id) ON DELETE CASCADE,
            case_key varchar(255) NOT NULL,
            question text NOT NULL,
            model varchar(255),
            intent varchar(100) NOT NULL DEFAULT '',
            expected jsonb NOT NULL DEFAULT '{}'::jsonb,
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (suite_id, case_key)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_evaluation_runs (
            id varchar(36) PRIMARY KEY,
            suite_id varchar(36) NOT NULL REFERENCES agent_evaluation_suites(id) ON DELETE CASCADE,
            status varchar(20) NOT NULL DEFAULT 'running',
            model varchar(255),
            judge_model varchar(255),
            total_cases integer NOT NULL DEFAULT 0,
            passed_cases integer NOT NULL DEFAULT 0,
            failed_cases integer NOT NULL DEFAULT 0,
            error_cases integer NOT NULL DEFAULT 0,
            average_score double precision,
            max_concurrency integer NOT NULL DEFAULT 1,
            selector varchar(255),
            metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now(),
            started_at timestamptz NOT NULL DEFAULT now(),
            completed_at timestamptz
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_evaluation_items (
            id varchar(36) PRIMARY KEY,
            run_id varchar(36) NOT NULL REFERENCES agent_evaluation_runs(id) ON DELETE CASCADE,
            case_id varchar(36) NOT NULL REFERENCES agent_evaluation_cases(id) ON DELETE CASCADE,
            passed boolean NOT NULL DEFAULT false,
            score double precision,
            snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
            metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
            error text,
            latency_ms double precision NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_agent_evaluation_cases_suite_id "
        "ON agent_evaluation_cases (suite_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_agent_evaluation_runs_suite_id "
        "ON agent_evaluation_runs (suite_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_agent_evaluation_items_run_id "
        "ON agent_evaluation_items (run_id)"
    )


def downgrade():
    op.drop_table("agent_evaluation_items")
    op.drop_table("agent_evaluation_runs")
    op.drop_table("agent_evaluation_cases")
    op.drop_table("agent_evaluation_suites")
