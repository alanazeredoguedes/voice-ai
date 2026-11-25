# Personalizações do instalador NSIS (o electron-builder inclui este arquivo sozinho).

# Antes de instalar por cima de uma versão antiga, remove dela os arquivos de caminho muito longo.
# Sem isso, o desinstalador da versão antiga aborta na atualização com
# "Falha ao desinstalar os arquivos do aplicativo antigo. Por favor, tente iniciar o instalador novamente.: 2"
# (explicação completa em build/clean-long-paths.ps1). Vale para toda atualização: o desinstalador que roda é sempre
# o da versão JÁ instalada, então só o instalador novo consegue "limpar o caminho" para ele.
!macro customInit
  Push $R8
  Push $R9
  ReadRegStr $R8 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R8 == ""
    ReadRegStr $R8 HKEY_CURRENT_USER "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${endIf}
  ${if} $R8 != ""
    InitPluginsDir
    File "/oname=$PLUGINSDIR\clean-long-paths.ps1" "${BUILD_RESOURCES_DIR}\clean-long-paths.ps1"
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\clean-long-paths.ps1" "$R8"`
    Pop $R9
    DetailPrint "Limpeza de caminhos longos da instalação anterior: código $R9"
  ${endIf}
  Pop $R9
  Pop $R8
!macroend
