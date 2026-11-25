# Chamado pelo instalador (build/installer.nsh, macro customInit) ANTES de ele rodar o desinstalador da versão antiga.
#
# Por quê: numa atualização, o desinstalador antigo move cada arquivo da pasta de instalação para uma pasta temporária
# (%TEMP%\nsXXXX.tmp\old-install\...) para poder desfazer se algo falhar. O NSIS não aceita caminhos com 260 caracteres
# ou mais, e o pacote "elevenlabs" (python-packages) tem arquivos com ~250 caracteres: somando o prefixo do TEMP, o
# destino passa de 260, o Rename falha e o desinstalador aborta com "Falha ao desinstalar os arquivos do aplicativo
# antigo ... : 2". Aqui removemos, da instalação ANTIGA, os arquivos de caminho muito longo (via prefixo \\?\, que
# aceita caminhos longos). É seguro: o instalador novo traz esses arquivos de novo logo em seguida.
#
# Uso: powershell -File clean-long-paths.ps1 "<pasta da instalação antiga>" [<tamanho máximo do caminho relativo>] [-WhatIf]
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [int]$MaxRelative = 130,
    [switch]$WhatIf
)
$ErrorActionPreference = 'SilentlyContinue'
$InstallDir = $InstallDir.TrimEnd('\')
if (-not (Test-Path -LiteralPath $InstallDir)) { exit 0 }

$prefix = '\\?\' + $InstallDir
$removed = 0
Get-ChildItem -LiteralPath $prefix -Recurse -File -Force | Where-Object {
    # tamanho do caminho relativo à pasta de instalação (sem o "\\?\" nem a pasta)
    ($_.FullName.Length - $prefix.Length) -gt $MaxRelative
} | ForEach-Object {
    if ($WhatIf) { "$($_.FullName.Length - $prefix.Length) $($_.FullName.Substring($prefix.Length))" }
    else { Remove-Item -LiteralPath $_.FullName -Force; $removed++ }
}
if (-not $WhatIf) { Write-Output "removidos: $removed" }
exit 0
