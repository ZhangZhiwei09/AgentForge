import pytest
from sqlalchemy import delete, func, select

from scripts.seed_identity_kb import IDENTITY_DOCS, IDENTITY_KB_ID, seed_documents
from src.models.base import Base
from src.models.knowledge import KnowledgeBase, KnowledgeChunk, KnowledgeDocument
from tests.browser_db import require_test_url


@pytest.mark.parametrize("url", [
    "postgresql://localhost/agentforge", "postgresql://localhost/postgres",
    "sqlite:///agentforge_test_e2e", "",
])
def test_browser_fixtures_refuse_non_disposable_database(url):
    with pytest.raises(ValueError):
        require_test_url(url)


def test_browser_fixtures_normalize_disposable_url():
    assert require_test_url("postgresql://localhost/agentforge_test_e2e").drivername == "postgresql+asyncpg"


async def test_identity_seed_repairs_partial_seed_without_overwriting_content(entry_api):
    _, sessions = entry_api
    async with sessions.kw["bind"].begin() as connection:
        await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
            KnowledgeBase.__table__, KnowledgeDocument.__table__, KnowledgeChunk.__table__,
        ]))
    async with sessions() as db:
        ids = await seed_documents(db)
        assert len(ids) == len(IDENTITY_DOCS)
        first = await db.get(KnowledgeDocument, ids[0])
        first.content = "operator-edited content"
        await db.execute(delete(KnowledgeDocument).where(KnowledgeDocument.id == ids[-1]))
        await db.commit()
        repeated = await seed_documents(db)
        assert repeated == ids
        await db.refresh(first)
        assert first.content == "operator-edited content"
        assert await db.scalar(select(func.count()).select_from(KnowledgeDocument).where(
            KnowledgeDocument.knowledge_base_id == IDENTITY_KB_ID,
        )) == len(IDENTITY_DOCS)
