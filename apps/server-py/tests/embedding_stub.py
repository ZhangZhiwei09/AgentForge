"""Deterministic embedding HTTP fixture for independent browser acceptance."""

import hashlib
import math

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class EmbeddingsRequest(BaseModel):
    input: list[str]
    model: str


@app.post("/v1/embeddings")
async def embeddings(body: EmbeddingsRequest):
    data = []
    for index, value in enumerate(body.input):
        vector = [0.0] * 1024
        for char in value:
            slot = int.from_bytes(hashlib.sha256(char.encode()).digest()[:2]) % 1024
            vector[slot] += 1
        norm = math.sqrt(sum(item * item for item in vector)) or 1
        data.append({"object": "embedding", "index": index, "embedding": [item / norm for item in vector]})
    return {"object": "list", "model": body.model, "data": data, "usage": {"prompt_tokens": 0, "total_tokens": 0}}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8011, access_log=False)
