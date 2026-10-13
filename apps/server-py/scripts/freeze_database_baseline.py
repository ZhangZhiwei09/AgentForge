"""Generate the initial frozen PostgreSQL baseline; never run as a migration."""

import json
from pathlib import Path

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateIndex, CreateTable, DefaultClause

import src.models  # noqa: F401
from src.models.base import Base

EXTRA_INDEXES = {
    "conversations": [
        ("ix_conversations_session_id", ["session_id"]),
        ("ix_conversations_user_id", ["user_id"]),
        ("ix_conversations_user_updated", ["user_id", "updated_at"]),
        ("ix_conversations_type_created", ["type", "created_at"]),
    ],
    "messages": [
        ("ix_messages_conversation_id", ["conversation_id"]),
        ("ix_messages_conversation_created", ["conversation_id", "created_at"]),
    ],
    "knowledge_documents": [("ix_knowledge_documents_kb_id", ["knowledge_base_id"])],
    "knowledge_chunks": [
        ("ix_knowledge_chunks_doc_id", ["document_id"]),
        ("ix_knowledge_chunks_kb_id", ["knowledge_base_id"]),
    ],
    "knowledge_query_logs": [
        ("ix_query_log_kb", ["kb_id"]), ("ix_query_log_created", ["created_at"]),
    ],
    "knowledge_regression_test_sets": [("ix_regression_test_sets_kb", ["kb_id"])],
    "knowledge_regression_cases": [
        ("ix_regression_cases_test_set", ["test_set_id"]), ("ix_regression_cases_kb", ["kb_id"]),
    ],
    "knowledge_regression_runs": [
        ("ix_regression_runs_test_set", ["test_set_id"]), ("ix_regression_runs_kb", ["kb_id"]),
        ("ix_regression_runs_created", ["created_at"]),
    ],
    "knowledge_regression_run_items": [
        ("ix_regression_run_items_run", ["run_id"]), ("ix_regression_run_items_case", ["case_id"]),
    ],
    "agent_flow_runs": [
        ("agent_flow_runs_flow_id_created_at_idx", ["flow_id", "created_at"]),
        ("agent_flow_runs_conversation_id_status_idx", ["conversation_id", "status"]),
    ],
}


def main():
    dialect = postgresql.dialect()
    frozen = sa.MetaData()
    for table in Base.metadata.sorted_tables:
        table.to_metadata(frozen)
    for name, indexes in EXTRA_INDEXES.items():
        for index_name, columns in indexes:
            sa.Index(index_name, *(frozen.tables[name].c[column] for column in columns))
    sa.Index(
        "ix_knowledge_chunks_embedding_cosine", frozen.tables["knowledge_chunks"].c.embedding,
        postgresql_using="hnsw", postgresql_ops={"embedding": "vector_cosine_ops"},
    )
    statements = ["CREATE EXTENSION IF NOT EXISTS vector"]
    tables = {}
    for table in frozen.sorted_tables:
        for column in table.columns:
            if column.server_default is None and column.default is not None:
                value = column.default.arg
                if column.default.is_scalar:
                    column.server_default = DefaultClause(sa.text(sa.literal(value).compile(
                        dialect=dialect, compile_kwargs={"literal_binds": True},
                    ).string))
                elif callable(value) and value.__name__ in {"list", "dict"}:
                    literal = "'{}'" if isinstance(column.type, postgresql.ARRAY) or value.__name__ == "dict" else "'[]'"
                    column.server_default = DefaultClause(sa.text(literal))
        statements.append(str(CreateTable(table, if_not_exists=True).compile(dialect=dialect)).strip())
        tables[table.name] = {
            "columns": {column.name: str(column.type.compile(dialect=dialect)) for column in table.columns},
            "primary_key": [column.name for column in table.primary_key.columns],
        }
    for table in frozen.sorted_tables:
        for index in sorted(table.indexes, key=lambda index: index.name):
            statements.append(str(CreateIndex(index, if_not_exists=True).compile(dialect=dialect)))
    destination = Path(__file__).resolve().parents[1] / "alembic/baselines/20261013.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({"tables": tables, "statements": statements}, indent=2) + "\n", encoding="utf-8")
    print(f"Frozen {len(tables)} tables, {len(statements)} statements")


if __name__ == "__main__":
    main()
