from fastapi import FastAPI

app = FastAPI(title="AgentForge", version="0.0.1")


@app.get("/api/health")
async def health():
    return {"status": "ok"}
