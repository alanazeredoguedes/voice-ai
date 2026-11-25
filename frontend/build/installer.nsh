# Personalizações do instalador NSIS (o electron-builder inclui este arquivo sozinho).
#
# Os dois ganchos existem por causa dos arquivos de caminho muito longo do pacote "elevenlabs" (python-packages): alguns
# passam de 250 caracteres, e o NSIS não lida com caminhos de 260 caracteres ou mais.

# Remoção dos arquivos do app: roda na desinstalação e quando o desinstalador antigo é chamado numa atualização.
# O RMDir /r do NSIS não alcança os arquivos de caminho longo, que ficavam para trás na pasta de instalação depois de
# desinstalar. O "rd /s /q" com o prefixo \\?\ apaga tudo, inclusive esses, e é bem mais rápido que a remoção do padrão
# do electron-builder (renomeia cada arquivo para uma pasta temporária para poder desfazer; o desfazer nunca ajudou,
# porque a instalação nova vem logo em seguida).
!macro customRemoveFiles
  # sai da pasta antes de apagá-la (um processo com ela como pasta atual impediria de sumir)
  SetOutPath $TEMP
  Push $R9
  nsExec::Exec `"$SYSDIR\cmd.exe" /C rd /s /q "\\?\$INSTDIR"`
  Pop $R9
  DetailPrint "Remoção da pasta de instalação: código $R9"
  Pop $R9
  # o que sobrar (arquivo em uso) tenta de novo pelo caminho normal
  RMDir /r $INSTDIR
!macroend

# Antes de instalar por cima de uma versão antiga, remove dela os arquivos de caminho muito longo.
# Sem isso, o desinstalador da versão antiga (que ainda não tem o gancho acima) aborta na atualização com
# "Falha ao desinstalar os arquivos do aplicativo antigo. Por favor, tente iniciar o instalador novamente.: 2"
# (explicação completa em build/clean-long-paths.ps1). Vale para quem atualiza de versões anteriores: o desinstalador
# que roda é sempre o da versão JÁ instalada, então só o instalador novo consegue "limpar o caminho" para ele.
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
