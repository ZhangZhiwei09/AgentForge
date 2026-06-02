# AgentForge

## Quick Start

### Prerequisites
- Node.js >= 20
- pnpm >= 9
- Python >= 3.12
- PostgreSQL 16

### Install

```bash
pnpm install
```

### Environment

```bash
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env with your API keys
```

### Database

```bash
cd apps/api
alembic upgrade head
```

### Dev

```bash
# Start all services
pnpm dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:8000
- API Docs: http://localhost:8000/docs

### Docker

```bash
cd infra/docker
docker compose up -d
```
