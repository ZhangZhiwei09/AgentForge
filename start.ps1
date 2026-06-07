# AgentForge V2 - One-click startup script
# Usage: .\start.ps1

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AgentForge V2 - Starting All Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ── 0. Docker Network ───────────────────────────────────────
$netExists = docker network ls -q -f "name=agentforge-net"
if (-not $netExists) {
    docker network create agentforge-net 2>$null
}

# ── 1. Docker PostgreSQL ──────────────────────────────────────
Write-Host "`n[1/6] Checking PostgreSQL (Docker)..." -ForegroundColor Yellow

$container = docker ps -q -f "name=agentforge-pg"
if (-not $container) {
    $exists = docker ps -a -q -f "name=agentforge-pg"
    if ($exists) {
        Write-Host "  Starting existing container agentforge-pg..." -ForegroundColor Gray
        docker start agentforge-pg | Out-Null
    } else {
        Write-Host "  Creating PostgreSQL container..." -ForegroundColor Gray
        docker run -d --name agentforge-pg `
            --network agentforge-net `
            -e POSTGRES_USER=postgres `
            -e POSTGRES_PASSWORD=postgres `
            -e POSTGRES_DB=agentforge `
            -p 5434:5432 `
            -v pgdata:/var/lib/postgresql/data `
            postgres:16-alpine | Out-Null
    }
    Start-Sleep -Seconds 3
}

$ready = docker exec agentforge-pg pg_isready -U postgres -d agentforge 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: PostgreSQL failed to start" -ForegroundColor Red
    exit 1
}
Write-Host "  PostgreSQL ready on port 5434" -ForegroundColor Green

# ── 2. pgAdmin (GUI) ─────────────────────────────────────────
Write-Host "`n[2/6] Checking pgAdmin (Docker)..." -ForegroundColor Yellow

$pgadmin = docker ps -q -f "name=agentforge-pgadmin"
if (-not $pgadmin) {
    $exists = docker ps -a -q -f "name=agentforge-pgadmin"
    if ($exists) {
        Write-Host "  Starting existing pgAdmin container..." -ForegroundColor Gray
        docker start agentforge-pgadmin | Out-Null
    } else {
        Write-Host "  Creating pgAdmin container..." -ForegroundColor Gray
        docker run -d --name agentforge-pgadmin `
            --network agentforge-net `
            -p 5050:80 `
            -e PGADMIN_DEFAULT_EMAIL=admin@agentforge.io `
            -e PGADMIN_DEFAULT_PASSWORD=admin `
            -v pgadmin_data:/var/lib/pgadmin `
            dpage/pgadmin4:latest | Out-Null
    }
    Start-Sleep -Seconds 3
}
Write-Host "  pgAdmin ready on http://localhost:5050" -ForegroundColor Green
Write-Host "    Login: admin@agentforge.io / admin" -ForegroundColor Gray

# ── 3. Milvus Vector DB ──────────────────────────────────────
Write-Host "`n[3/6] Checking Milvus (Docker)..." -ForegroundColor Yellow

# etcd
$etcd = docker ps -q -f "name=agentforge-etcd"
if (-not $etcd) {
    $exists = docker ps -a -q -f "name=agentforge-etcd"
    if ($exists) {
        docker start agentforge-etcd | Out-Null
    } else {
        docker run -d --name agentforge-etcd `
            --network agentforge-net `
            -e ETCD_AUTO_COMPACTION_MODE=revision `
            -e ETCD_AUTO_COMPACTION_RETENTION=1000 `
            -e ETCD_QUOTA_BACKEND_BYTES=4294967296 `
            -e ETCD_SNAPSHOT_COUNT=50000 `
            -v etcd_data:/etcd `
            quay.io/coreos/etcd:v3.5.16 `
            etcd -advertise-client-urls=http://127.0.0.1:2379 -listen-client-urls http://0.0.0.0:2379 --data-dir /etcd | Out-Null
    }
}

# MinIO
$minio = docker ps -q -f "name=agentforge-minio"
if (-not $minio) {
    $exists = docker ps -a -q -f "name=agentforge-minio"
    if ($exists) {
        docker start agentforge-minio | Out-Null
    } else {
        docker run -d --name agentforge-minio `
            --network agentforge-net `
            -e MINIO_ACCESS_KEY=minioadmin `
            -e MINIO_SECRET_KEY=minioadmin `
            -v minio_data:/minio_data `
            minio/minio:RELEASE.2024-12-18T05-42-27Z `
            server /minio_data --console-address ":9001" | Out-Null
    }
}

Start-Sleep -Seconds 5

# Milvus Standalone
$milvus = docker ps -q -f "name=agentforge-milvus"
if (-not $milvus) {
    $exists = docker ps -a -q -f "name=agentforge-milvus"
    if ($exists) {
        docker start agentforge-milvus | Out-Null
    } else {
        docker run -d --name agentforge-milvus `
            --network agentforge-net `
            -e ETCD_ENDPOINTS=agentforge-etcd:2379 `
            -e MINIO_ADDRESS=agentforge-minio:9000 `
            -e MINIO_ACCESS_KEY_ID=minioadmin `
            -e MINIO_SECRET_ACCESS_KEY=minioadmin `
            -p 19530:19530 `
            -p 9091:9091 `
            -v milvus_data:/var/lib/milvus `
            milvusdb/milvus:v2.4.15 `
            milvus run standalone | Out-Null
    }
    Start-Sleep -Seconds 10
}
Write-Host "  Milvus ready on port 19530" -ForegroundColor Green

# ── 4. Backend (TS Hono) ──────────────────────────────────────
Write-Host "`n[4/6] Starting backend (Hono)... " -ForegroundColor Yellow

Write-Host "  Installing Node.js dependencies..." -ForegroundColor Gray
Push-Location $RootDir
pnpm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: pnpm install had issues, continuing..." -ForegroundColor Yellow
}

Write-Host "  Generating Prisma client..." -ForegroundColor Gray
pnpm --filter @agentforge/database db:generate
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: Prisma generate had issues, continuing..." -ForegroundColor Yellow
}

Write-Host "  Running database migrations..." -ForegroundColor Gray
pnpm --filter @agentforge/database db:migrate
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: Database migration failed, continuing anyway..." -ForegroundColor Yellow
}
Pop-Location

Write-Host "  Starting TS server on http://localhost:8000" -ForegroundColor Gray
Start-Process -FilePath "pnpm" `
    -ArgumentList "--filter", "@agentforge/server", "dev" `
    -WorkingDirectory $RootDir `
    -WindowStyle Minimized

Start-Sleep -Seconds 3

# ── 5. Frontend (Vite) ────────────────────────────────────────
Write-Host "`n[5/6] Starting frontend (Vite)..." -ForegroundColor Yellow

$WebDir = Join-Path $RootDir "apps\web"

Write-Host "  Starting Vite on http://localhost:5173" -ForegroundColor Gray
Start-Process -FilePath "pnpm" `
    -ArgumentList "--filter", "@agentforge/web", "dev" `
    -WorkingDirectory $RootDir `
    -WindowStyle Minimized

# ── Done ──────────────────────────────────────────────────────
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  All services starting!" -ForegroundColor Green
Write-Host "  Frontend : http://localhost:5173" -ForegroundColor White
Write-Host "  Backend  : http://localhost:8000" -ForegroundColor White
Write-Host "  API Docs : http://localhost:8000/docs" -ForegroundColor White
Write-Host "  pgAdmin  : http://localhost:5050" -ForegroundColor White
Write-Host "  DB Port  : 5434" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "`nClose the minimized windows to stop services." -ForegroundColor Gray
