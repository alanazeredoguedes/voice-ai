@echo off
rem Atalho Windows: executa build.ps1 (gera o instalador .exe em frontend\dist)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
