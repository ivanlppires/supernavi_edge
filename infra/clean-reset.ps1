##############################################################################
# SuperNavi Edge - Clean Reset
#
# Limpa tudo (DB, Redis, arquivos) e rebuilda os containers.
# Uso: .\infra\clean-reset.ps1
# Depois: basta digitalizar uma lamina nova em C:\Slides
##############################################################################

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== SuperNavi Edge - Clean Reset ===" -ForegroundColor Cyan
Write-Host ""

# 1. Pull latest code
Write-Host "[1/7] git pull..." -ForegroundColor Yellow
git pull
Write-Host ""

# 2. Stop all containers
Write-Host "[2/7] Parando containers..." -ForegroundColor Yellow
docker compose down
Write-Host ""

# 3. Start only DB and Redis
Write-Host "[3/7] Subindo DB e Redis..." -ForegroundColor Yellow
docker compose up -d db redis
Start-Sleep -Seconds 3

# 4. Wipe database
Write-Host "[4/7] Limpando banco de dados..." -ForegroundColor Yellow
docker compose exec db psql -U supernavi -c @"
DELETE FROM outbox_events;
DELETE FROM scanner_files;
DELETE FROM messages;
DELETE FROM threads;
DELETE FROM annotations;
DELETE FROM case_slides;
DELETE FROM jobs;
DELETE FROM slides;
"@
Write-Host "  DB limpo." -ForegroundColor Green

# 5. Flush Redis
Write-Host "[5/7] Limpando Redis..." -ForegroundColor Yellow
docker compose exec redis redis-cli FLUSHDB
Write-Host "  Redis limpo." -ForegroundColor Green

# 6. Clean data directories
Write-Host "[6/7] Limpando arquivos (raw + derived)..." -ForegroundColor Yellow
if (Test-Path .\data\raw\*) { Remove-Item -Recurse -Force .\data\raw\* }
if (Test-Path .\data\derived\*) { Remove-Item -Recurse -Force .\data\derived\* }
Write-Host "  Arquivos limpos." -ForegroundColor Green

# 7. Rebuild and start everything
Write-Host "[7/7] Rebuild e start..." -ForegroundColor Yellow
Write-Host ""
docker compose up -d --build

Write-Host ""
Write-Host "=== Reset completo! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Proximo passo: digitalize uma lamina nova." -ForegroundColor Cyan
Write-Host "Acompanhe com: docker compose logs -f api processor" -ForegroundColor Cyan
Write-Host ""
