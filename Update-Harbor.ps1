param([switch]$NoLaunch, [string]$DesktopDirectory)
$ErrorActionPreference = 'Stop'
$harborRoot = $PSScriptRoot
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Install Git for Windows before updating.' }
if (-not (Test-Path -LiteralPath (Join-Path $harborRoot '.git'))) { throw 'This copy was downloaded as a ZIP. Use git clone for one-command updates.' }
# Never replace dependencies beneath a running Harbor from this checkout.
$harborExecutables = @((Join-Path $harborRoot 'node_modules\electron\dist\electron.exe'), (Join-Path $harborRoot '.runtime\node-v24.15.0-win-x64\node.exe'))
$harborRunning = Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and ($harborExecutables -contains $_.ExecutablePath) -and
  ($_.CommandLine -and $_.CommandLine.Contains($harborRoot))
}
if ($harborRunning) { throw 'Save your work and fully close Harbor before running Update-Harbor.cmd. No session has been stopped.' }
Push-Location $harborRoot
try {
  $harborChanges = & git status --porcelain --untracked-files=no
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the Git checkout.' }
  if ($harborChanges) { throw 'Source files have local changes. Commit or move your changes before updating. Nothing was overwritten.' }
  & git pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'Git update failed. Check network access and the Git message above. Local data was not removed.' }
} finally { Pop-Location }
& (Join-Path $harborRoot 'Setup-Harbor.ps1') -NoLaunch:$NoLaunch -DesktopDirectory $DesktopDirectory
