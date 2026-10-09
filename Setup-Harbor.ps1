param([switch]$NoLaunch, [string]$DesktopDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$harborRoot = $PSScriptRoot
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
  throw 'Harbor setup currently supports 64-bit Windows only.'
}
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
  throw 'This setup supports Windows x64. Windows ARM64 is not supported yet.'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$harborVersion = '24.15.0'
$harborHash = 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'
$harborRuntime = Join-Path $harborRoot '.runtime'
$harborNodeDirectory = Join-Path $harborRuntime "node-v$harborVersion-win-x64"
$harborNode = Join-Path $harborNodeDirectory 'node.exe'
New-Item -ItemType Directory -Path $harborRuntime -Force | Out-Null
if (-not (Test-Path -LiteralPath $harborNode -PathType Leaf)) {
  $harborZip = Join-Path $harborRuntime "node-v$harborVersion-win-x64.zip"
  Write-Host "Downloading Node.js $harborVersion from nodejs.org..."
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$harborVersion/node-v$harborVersion-win-x64.zip" -OutFile $harborZip
  if ((Get-FileHash -LiteralPath $harborZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $harborHash) {
    Remove-Item -LiteralPath $harborZip
    throw 'Node.js checksum mismatch. Installation stopped.'
  }
  Expand-Archive -LiteralPath $harborZip -DestinationPath $harborRuntime -Force
  Remove-Item -LiteralPath $harborZip
}
$env:PATH = "$harborNodeDirectory;$env:PATH"
$env:HARBOR_NODE = $harborNode
$harborNpm = Join-Path $harborNodeDirectory 'npm.cmd'
Push-Location $harborRoot
try {
  Write-Host 'Installing locked dependencies (including Electron)...'
  & $harborNpm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the npm error above.' }
  Write-Host 'Building Harbor...'
  & $harborNpm run build
  if ($LASTEXITCODE -ne 0) { throw 'Harbor build failed.' }
  Set-Content -LiteralPath (Join-Path $harborRuntime 'source-install') -Value 'Source installation' -Encoding ASCII
  try {
    & (Join-Path $harborRoot 'scripts\create-desktop-shortcut.ps1') -HarborRoot $harborRoot -DesktopDirectory $DesktopDirectory
  } catch {
    Write-Warning "Harbor is installed, but the desktop shortcut could not be created: $($_.Exception.Message). Use Start-Harbor.cmd to open it."
  }
  Write-Host 'Harbor is ready. Open the Harbor desktop icon or use Start-Harbor.cmd next time.'
} finally { Pop-Location }
if (-not $NoLaunch) { & (Join-Path $harborRoot 'Start-Harbor-Desktop.ps1') }
