# AgentForge

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm >= 9
- Docker Desktop
- PostgreSQL 16

### Install

```bash
pnpm install
```

### Environment

```bash
cp apps/server/.env.example apps/server/.env
# Edit apps/server/.env with your API keys
```

### Database

```bash
pnpm db:generate
pnpm db:migrate
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
