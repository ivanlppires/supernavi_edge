##############################################################################
# SuperNavi Edge - Clean Reset (Edge + Cloud)
#
# Limpa tudo (DB, Redis, arquivos, cloud) e rebuilda os containers.
# Uso: .\infra\clean-reset.ps1
# Depois: basta digitalizar uma lamina nova em C:\Slides
##############################################################################

param(
  [string]$CloudUrl = "https://cloud.supernavi.app",
  [string]$CloudApiKey = "snavi-dev-bridge-key-2026"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== SuperNavi - Clean Reset (Edge + Cloud) ===" -ForegroundColor Cyan
Write-Host ""

# 1. Pull latest code
Write-Host "[1/8] git pull..." -ForegroundColor Yellow
git pull
Write-Host ""

# 2. Stop all containers
Write-Host "[2/8] Parando containers..." -ForegroundColor Yellow
docker compose down
Write-Host ""

# 3. Start only DB and Redis
Write-Host "[3/8] Subindo DB e Redis..." -ForegroundColor Yellow
docker compose up -d db redis
Start-Sleep -Seconds 3

# 4. Wipe edge database
Write-Host "[4/8] Limpando banco de dados (edge)..." -ForegroundColor Yellow
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
Write-Host "  Edge DB limpo." -ForegroundColor Green

# 5. Flush Redis
Write-Host "[5/8] Limpando Redis..." -ForegroundColor Yellow
docker compose exec redis redis-cli FLUSHDB
Write-Host "  Redis limpo." -ForegroundColor Green

# 6. Clean data directories
Write-Host "[6/8] Limpando arquivos (raw + derived)..." -ForegroundColor Yellow
if (Test-Path .\data\raw\*) { Remove-Item -Recurse -Force .\data\raw\* }
if (Test-Path .\data\derived\*) { Remove-Item -Recurse -Force .\data\derived\* }
Write-Host "  Arquivos limpos." -ForegroundColor Green

# 7. Wipe cloud data
Write-Host "[7/8] Limpando cloud ($CloudUrl)..." -ForegroundColor Yellow
try {
  $headers = @{ "x-supernavi-key" = $CloudApiKey }
  $response = Invoke-RestMethod -Uri "$CloudUrl/api/admin/dev-reset" -Method POST -ContentType "application/json" -Headers $headers
  if ($response.ok) {
    Write-Host "  Cloud limpo: slides=$($response.deleted.slides_read) previews=$($response.deleted.preview_assets) events=$($response.deleted.events_slide)" -ForegroundColor Green
  }
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 403) {
    Write-Host "  Cloud: dev-reset desabilitado (production mode)" -ForegroundColor Yellow
  } else {
    Write-Host "  Cloud: nao foi possivel limpar ($($_.Exception.Message))" -ForegroundColor Yellow
    Write-Host "  (limpe manualmente se necessario)" -ForegroundColor Yellow
  }
}

# 8. Rebuild and start everything
Write-Host "[8/8] Rebuild e start..." -ForegroundColor Yellow
Write-Host ""
docker compose up -d --build

Write-Host ""
Write-Host "=== Reset completo! ===" -ForegroundColor Green
Write-Host ""
Write-Host "Proximo passo: digitalize uma lamina nova." -ForegroundColor Cyan
Write-Host "Acompanhe com: docker compose logs -f api processor" -ForegroundColor Cyan
Write-Host ""
