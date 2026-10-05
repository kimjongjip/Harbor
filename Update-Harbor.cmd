@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Harbor.ps1" %*
if errorlevel 1 (
  echo Harbor update failed. See the error above.
  exit /b 1
)
