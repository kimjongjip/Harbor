@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Harbor.ps1" %*
if errorlevel 1 (
  echo Harbor setup failed. See the error above.
  exit /b 1
)
