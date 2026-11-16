@echo off
setlocal
if not exist "%~dp0Setup-Harbor.ps1" (
  echo [FAILED] Extract the entire Harbor ZIP before running Setup-Harbor.cmd.
  if not "%HARBOR_SETUP_NO_PAUSE%"=="1" pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-Harbor.ps1" %*
set "harborSetupExit=%errorlevel%"
echo.
if "%harborSetupExit%"=="0" (
  echo [SUCCESS] Harbor installation completed.
  echo Open the Harbor desktop icon or Start-Harbor.cmd.
) else (
  echo [FAILED] Harbor setup did not finish successfully. See the error above.
)
echo Setup log: "%~dp0.runtime\setup.log"
if not "%HARBOR_SETUP_NO_PAUSE%"=="1" pause
exit /b %harborSetupExit%
