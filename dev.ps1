# Equivalente Windows do dev.sh: sobe o backend e o frontend em modo dev.
# Uso:  powershell -ExecutionPolicy Bypass -File .\dev.ps1
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$Python = Join-Path $Root 'backend\venv\Scripts\python.exe'

if (-not (Test-Path $Python)) {
    Write-Host "[dev] venv nao encontrada. Rode:" -ForegroundColor Yellow
    Write-Host "      cd backend; python -m venv venv; .\venv\Scripts\python.exe -m pip install -r requirements.txt"
    exit 1
}

$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

Write-Host "[dev] iniciando backend..."
$backend = Start-Process -FilePath $Python -ArgumentList '-m', 'backend.main' `
    -WorkingDirectory $Root -NoNewWindow -PassThru

Write-Host "[dev] aguardando backend em :18450..."
for ($i = 0; $i -lt 60; $i++) {
    try {
        Invoke-WebRequest -Uri 'http://127.0.0.1:18450/health' -UseBasicParsing -TimeoutSec 1 | Out-Null
        Write-Host "[dev] backend pronto"
        break
    } catch { Start-Sleep -Milliseconds 500 }
}

try {
    Write-Host "[dev] iniciando frontend..."
    Push-Location (Join-Path $Root 'frontend')
    npm run dev
} finally {
    Pop-Location
    Write-Host "[dev] encerrando..."
    if ($backend -and -not $backend.HasExited) { Stop-Process -Id $backend.Id -Force }
}
