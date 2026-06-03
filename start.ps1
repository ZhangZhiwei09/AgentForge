# AgentForge V1 - One-click startup script
# Usage: .\start.ps1

$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AgentForge V1 - Starting All Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ── 1. Docker PostgreSQL ──────────────────────────────────────
Write-Host "`n[1/3] Checking PostgreSQL (Docker)..." -ForegroundColor Yellow

$container = docker ps -q -f "name=agentforge-pg"
if (-not $container) {
    $exists = docker ps -a -q -f "name=agentforge-pg"
    if ($exists) {
        Write-Host "  Starting existing container agentforge-pg..." -ForegroundColor Gray
        docker start agentforge-pg | Out-Null
    } else {
        Write-Host "  Creating PostgreSQL container..." -ForegroundColor Gray
        docker run -d --name agentforge-pg `
            -e POSTGRES_USER=postgres `
            -e POSTGRES_PASSWORD=postgres `
            -e POSTGRES_DB=agentforge `
            -p 5434:5432 `
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

# ── 2. Backend (uvicorn) ──────────────────────────────────────
Write-Host "`n[2/3] Starting backend (FastAPI)..." -ForegroundColor Yellow

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

# ── 3. Frontend (Vite) ────────────────────────────────────────
Write-Host "`n[3/3] Starting frontend (Vite)..." -ForegroundColor Yellow

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
Write-Host "  DB Port  : 5434" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "`nClose the minimized windows to stop services." -ForegroundColor Gray
