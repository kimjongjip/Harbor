param([switch]$NoLaunch, [string]$DesktopDirectory, [switch]$SkipShortcut)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$harborRoot = $PSScriptRoot
$harborRuntime = Join-Path $harborRoot '.runtime'
$harborLog = Join-Path $harborRuntime 'setup.log'
$harborResult = Join-Path $harborRuntime 'setup-result.json'
$harborTranscript = $false
$harborInstalled = $false
$harborStep = 'runtime'
try {
  New-Item -ItemType Directory -Path $harborRuntime -Force | Out-Null
  Start-Transcript -LiteralPath $harborLog -Force | Out-Null
  $harborTranscript = $true
  if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) {
    throw 'Harbor setup currently supports 64-bit Windows only.'
  }
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This setup supports Windows x64. Windows ARM64 is not supported yet.'
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $harborVersion = '24.15.0'
  $harborHash = 'cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62'
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
    $harborStep = 'dependencies'
    & $harborNpm ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the npm error above.' }
    # Recent Electron packages download their binary on first use, not npm ci.
    # Install it explicitly before reporting success or selecting this update.
    $harborStep = 'desktop-runtime'
    Write-Host 'Preparing the Electron desktop runtime...'
    $harborElectronInstaller = Join-Path $harborRoot 'node_modules\electron\install.js'
    if (-not (Test-Path -LiteralPath $harborElectronInstaller -PathType Leaf)) { throw 'Electron package is missing. Dependency installation did not include the desktop runtime.' }
    $harborElectronEnv = @{}
    foreach ($harborName in @('ELECTRON_INSTALL_PLATFORM', 'ELECTRON_INSTALL_ARCH', 'ELECTRON_OVERRIDE_DIST_PATH')) {
      $harborElectronEnv[$harborName] = [Environment]::GetEnvironmentVariable($harborName, 'Process')
    }
    try {
      $env:ELECTRON_INSTALL_PLATFORM = 'win32'
      $env:ELECTRON_INSTALL_ARCH = 'x64'
      Remove-Item Env:ELECTRON_OVERRIDE_DIST_PATH -ErrorAction SilentlyContinue
      & $harborNode $harborElectronInstaller
      if ($LASTEXITCODE -ne 0) { throw 'Electron runtime download failed. Check the network error above and retry Setup-Harbor.cmd.' }
    } finally {
      foreach ($harborName in $harborElectronEnv.Keys) {
        [Environment]::SetEnvironmentVariable($harborName, $harborElectronEnv[$harborName], 'Process')
      }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $harborRoot 'node_modules\electron\dist\electron.exe') -PathType Leaf)) { throw 'Electron runtime is still missing after installation. See .runtime\setup.log.' }
    Write-Host 'Building Harbor...'
    $harborStep = 'build'
    & $harborNpm run build
    if ($LASTEXITCODE -ne 0) { throw 'Harbor build failed.' }
    foreach ($harborOutput in @('dist\server.mjs', 'dist\client\index.html')) {
      if (-not (Test-Path -LiteralPath (Join-Path $harborRoot $harborOutput) -PathType Leaf)) { throw "Harbor build output is missing: $harborOutput" }
    }
    $harborInstalled = $true
    Set-Content -LiteralPath (Join-Path $harborRuntime 'source-install') -Value 'Source installation' -Encoding ASCII
    if (-not $SkipShortcut) {
      $harborOldUpdate = Join-Path $harborRuntime 'desktop-update.json'
      if (Test-Path -LiteralPath $harborOldUpdate -PathType Leaf) { Remove-Item -LiteralPath $harborOldUpdate }
      try {
        & (Join-Path $harborRoot 'scripts\create-desktop-shortcut.ps1') -HarborRoot $harborRoot -DesktopDirectory $DesktopDirectory
      } catch {
        Write-Warning "Harbor is installed, but the desktop shortcut could not be created: $($_.Exception.Message). Use Start-Harbor.cmd to open it."
      }
    }
    Write-Host 'Harbor is ready. Open the Harbor desktop icon or use Start-Harbor.cmd next time.'
  } finally { Pop-Location }
  if (-not $NoLaunch) { $harborStep = 'launch'; & (Join-Path $harborRoot 'Start-Harbor-Desktop.ps1') }
  @{ status = 'installed'; installed = $true; launchRequested = -not [bool]$NoLaunch; finishedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $harborResult -Encoding UTF8
  Write-Host '[SUCCESS] Harbor installation completed.' -ForegroundColor Green
  Write-Host "Setup log: $harborLog"
} catch {
  Write-Host "[FAILED] Harbor setup step: $harborStep" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host "Setup log: $harborLog"
  try { @{ status = 'failed'; installed = $harborInstalled; step = $harborStep; error = $_.Exception.Message; finishedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $harborResult -Encoding UTF8 } catch {}
  throw
} finally {
  if ($harborTranscript) { Stop-Transcript | Out-Null }
}
