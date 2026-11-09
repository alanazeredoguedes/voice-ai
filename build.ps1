# Equivalente Windows do build.sh: gera o instalador frontend\dist\Voice AI Setup <versao>.exe
# Uso:  powershell -ExecutionPolicy Bypass -File .\build.ps1
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$PyDist = Join-Path $Root 'backend\python-dist'

# Python portátil (python-build-standalone) embutido no app - o mesmo papel do python-dist do Linux
$PyVersion = '3.12.16'
$PyRelease = '20261026'
if (-not (Test-Path (Join-Path $PyDist 'python.exe'))) {
    Write-Host "[build] baixando Python $PyVersion portatil..."
    $tmp = Join-Path $env:TEMP "voice-ai-python-$PyRelease"
    New-Item -ItemType Directory -Force $tmp | Out-Null
    $url = "https://github.com/astral-sh/python-build-standalone/releases/download/$PyRelease/cpython-$PyVersion%2B$PyRelease-x86_64-pc-windows-msvc-install_only.tar.gz"
    $tgz = Join-Path $tmp 'python.tar.gz'
    Invoke-WebRequest -Uri $url -OutFile $tgz -UseBasicParsing
    tar -xzf $tgz -C $tmp
    if (Test-Path $PyDist) { Remove-Item -Recurse -Force $PyDist }
    Move-Item (Join-Path $tmp 'python') $PyDist
    Remove-Item -Recurse -Force $tmp
}

# Runtime do Visual C++ ao lado do python.exe (deploy "app-local", permitido pela Microsoft):
# o ctranslate2 (Whisper) importa msvcp140.dll, que o python-build-standalone não traz e que
# um Windows recém-instalado pode não ter. Assim o usuário não precisa instalar o VC++ Redist.
$vcDlls = 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic_wait.dll',
          'msvcp140_codecvt_ids.dll', 'concrt140.dll', 'vcomp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'
foreach ($dll in $vcDlls) {
    $dst = Join-Path $PyDist $dll
    $src = Join-Path $env:SystemRoot "System32\$dll"
    if (-not (Test-Path $dst)) {
        if (Test-Path $src) { Copy-Item $src $dst; Write-Host "[build] runtime VC++: $dll" }
        elseif ($dll -eq 'msvcp140.dll') { throw "msvcp140.dll nao encontrada em System32 - instale o VC++ Redistributable (x64) na maquina de build" }
    }
}

# electron-builder: o pacote winCodeSign contém symlinks de macOS que o Windows não cria sem
# modo desenvolvedor/admin. Pré-extrai no cache ignorando a pasta darwin (não usada no Windows).
$wcsDir = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign\winCodeSign-2.6.0'
if (-not (Test-Path (Join-Path $wcsDir 'rcedit-x64.exe'))) {
    Write-Host "[build] preparando cache do winCodeSign..."
    $wcs7z = Join-Path $env:TEMP 'winCodeSign-2.6.0.7z'
    Invoke-WebRequest -Uri 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z' -OutFile $wcs7z -UseBasicParsing
    & (Join-Path $Root 'frontend\node_modules\7zip-bin\win\x64\7za.exe') x -bd -y $wcs7z "-o$wcsDir" '-xr!darwin' | Out-Null
    Remove-Item $wcs7z
}

$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
Push-Location (Join-Path $Root 'frontend')
try {
    npm run build:win
    if ($LASTEXITCODE -ne 0) { throw "build falhou ($LASTEXITCODE)" }
    if (Test-Path 'dist\win-unpacked') { Remove-Item -Recurse -Force 'dist\win-unpacked' }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Build concluido:"
Get-ChildItem (Join-Path $Root 'frontend\dist\*.exe') | ForEach-Object { "{0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB) }
