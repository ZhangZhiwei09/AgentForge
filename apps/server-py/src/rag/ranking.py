"""Rank fusion, content deduplication and bounded HTTP reranking."""

import logging
import math
from dataclasses import replace

import httpx

from src.config import settings
from src.rag.types import KnowledgeSearchResult

logger = logging.getLogger(__name__)


def rrf_fusion(
    dense: list[KnowledgeSearchResult], sparse: list[KnowledgeSearchResult], limit: int,
) -> list[KnowledgeSearchResult]:
    results = {}
    scores = {}
    for source, candidates in (("pgvector", dense), ("elasticsearch", sparse)):
        seen = set()
        for rank, candidate in enumerate(candidates, 1):
            if candidate.chunk_id in seen:
                continue
            seen.add(candidate.chunk_id)
            if candidate.chunk_id not in results:
                results[candidate.chunk_id] = replace(candidate, recall_sources=[])
                scores[candidate.chunk_id] = 0
            result = results[candidate.chunk_id]
            scores[candidate.chunk_id] += 1 / (60 + rank)
            result.recall_sources.append(source)
    ordered = sorted(results.values(), key=lambda item: scores[item.chunk_id], reverse=True)[:limit]
    return [
        replace(item, score=round(scores[item.chunk_id], 4),
                fusion_score=round(scores[item.chunk_id], 4), score_type="rrf")
        for item in ordered
    ]


def token_overlap(first: str, second: str) -> float:
    def bigrams(text: str) -> set[str]:
        return {text[index:index + 2] for index in range(max(1, len(text) - 1))} if text else set()

    left, right = bigrams(first), bigrams(second)
    return len(left & right) / len(left | right) if left and right else 0


def dedupe(candidates: list[KnowledgeSearchResult]) -> list[KnowledgeSearchResult]:
    kept = []
    for candidate in candidates:
        if all(token_overlap(candidate.content, prior.content) <= settings.kb_dedupe_similarity_threshold
               for prior in kept):
            kept.append(candidate)
    return kept


async def rerank(query: str, candidates: list[KnowledgeSearchResult], top_k: int) -> list[KnowledgeSearchResult]:
    if not candidates or not settings.reranker_base_url or not settings.reranker_model:
        return []
    try:
        async with httpx.AsyncClient(timeout=5, trust_env=False) as client:
            response = await client.post(settings.reranker_base_url.rstrip("/") + "/rerank", json={
                "model": settings.reranker_model, "query": query,
                "documents": [{"text": item.content[:800], "id": item.chunk_id} for item in candidates],
                "topK": top_k,
            })
            response.raise_for_status()
            payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise TypeError("Invalid reranker results")
        results = []
        seen = set()
        for item in payload["results"]:
            if not isinstance(item, dict):
                raise TypeError("Invalid reranker item")
            index = item.get("index")
            score = item.get("relevance_score", item.get("score"))
            if (type(index) is not int or not 0 <= index < len(candidates) or index in seen
                    or type(score) not in (int, float) or not math.isfinite(score)):
                raise ValueError("Invalid reranker index or score")
            seen.add(index)
            results.append(replace(
                candidates[index], score=round(score, 4), rerank_score=round(score, 4), score_type="reranker",
            ))
        return sorted(results, key=lambda item: item.score, reverse=True)[:top_k]
    except (httpx.HTTPError, ValueError, TypeError):
        logger.warning("Reranker unavailable or returned invalid results; using fused ranks")
        return []
