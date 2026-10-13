"""Complete Python baseline, retaining the historical Alembic revision chain."""

import json
from pathlib import Path

from alembic import op

revision = "20261013_python_baseline"
down_revision = "a3f2e1d0c9b8"
branch_labels = None
depends_on = None


def upgrade():
    baseline = json.loads((Path(__file__).parents[1] / "baselines/20261013.json").read_text(encoding="utf-8"))
    for statement in baseline["statements"]:
        op.execute(statement)


def downgrade():
    raise RuntimeError("The adopted Python baseline cannot be downgraded; restore a database backup explicitly.")
