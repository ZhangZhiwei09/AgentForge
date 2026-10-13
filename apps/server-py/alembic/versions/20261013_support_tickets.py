"""Initialize the previously uninitialized business ticket store."""

from sqlalchemy import inspect

from alembic import op

revision = "20261013_support_tickets"
down_revision = "20261013_python_baseline"
branch_labels = None
depends_on = None


def upgrade():
    inspector = inspect(op.get_bind())
    if "support_tickets" in inspector.get_table_names():
        columns = {column["name"] for column in inspector.get_columns("support_tickets")}
        required = {"id", "ticket_id", "summary", "priority", "category", "status", "created_at", "updated_at"}
        if required - columns:
            raise RuntimeError("Existing support_tickets schema is incompatible; apply an explicit repair migration")
    op.execute("""
        CREATE TABLE IF NOT EXISTS support_tickets (
            id varchar(36) PRIMARY KEY, ticket_id varchar(64) NOT NULL UNIQUE,
            summary text NOT NULL, priority varchar(20) NOT NULL DEFAULT 'normal',
            category varchar(100) NOT NULL DEFAULT '通用', status varchar(20) NOT NULL DEFAULT 'open',
            created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
        )
    """)


def downgrade():
    op.drop_table("support_tickets")
