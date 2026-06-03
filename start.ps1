# AgentForge V1 - One-click startup script
# Usage: .\start.ps1

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AgentForge V1 - Starting All Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ── 0. Docker Network ───────────────────────────────────────
docker network create agentforge-net 2>$null

# ── 1. Docker PostgreSQL ──────────────────────────────────────
Write-Host "`n[1/4] Checking PostgreSQL (Docker)..." -ForegroundColor Yellow

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
Write-Host "`n[2/4] Checking pgAdmin (Docker)..." -ForegroundColor Yellow

$pgadmin = docker ps -q -f "name=agentforge-pgadmin"
if (-not $pgadmin) {
    $exists = docker ps -a -q -f "name=agentforge-pgadmin"
    if ($exists) {
        Write-Host "  Starting existing pgAdmin container..." -ForegroundColor Gray
        docker start agentforge-pgadmin | Out-Null
    } else {
        Write-Host "  Creating pgAdmin container..." -ForegroundColor Gray
        docker run -d --name agentforge-pgadmin `
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

# ── 3. Backend (uvicorn) ──────────────────────────────────────
Write-Host "`n[3/4] Starting backend (FastAPI)..." -ForegroundColor Yellow

$ApiDir = Join-Path $RootDir "apps\api"
$VenvPython = Join-Path $ApiDir ".venv\Scripts\python.exe"

if (-not (Test-Path $VenvPython)) {
    Write-Host "  Creating Python virtual environment..." -ForegroundColor Gray
    $Py312 = "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python312\python.exe"
    if (-not (Test-Path $Py312)) {
        Write-Host "  ERROR: Python 3.12 not found at $Py312" -ForegroundColor Red
        exit 1
    }
    & $Py312 -m venv (Join-Path $ApiDir ".venv")
    & $VenvPython -m pip install -e $ApiDir | Out-Null
}

Write-Host "  Starting uvicorn on http://localhost:8000" -ForegroundColor Gray
Start-Process -FilePath $VenvPython `
    -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload" `
    -WorkingDirectory $ApiDir `
    -WindowStyle Minimized

# ── 4. Frontend (Vite) ────────────────────────────────────────
Write-Host "`n[4/4] Starting frontend (Vite)..." -ForegroundColor Yellow

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
