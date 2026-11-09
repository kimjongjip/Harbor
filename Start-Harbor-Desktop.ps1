param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$harborRoot = $PSScriptRoot
$harborPortableNode = Join-Path $harborRoot '.runtime\node-v24.15.0-win-x64\node.exe'
if (Test-Path -LiteralPath $harborPortableNode) {
  $env:HARBOR_NODE = $harborPortableNode
  $env:PATH = "$(Split-Path -Parent $harborPortableNode);$env:PATH"
}
$harborPackaged = Join-Path $harborRoot 'release\Harbor-win32-x64\Harbor.exe'
$harborReleaseRoot = [IO.Path]::GetFullPath((Join-Path $harborRoot 'release'))
$harborReleasePointer = Join-Path $harborReleaseRoot 'current.json'
if (Test-Path -LiteralPath $harborReleasePointer) {
  $harborRelease = Get-Content -LiteralPath $harborReleasePointer -Raw -Encoding UTF8 | ConvertFrom-Json
  $harborReleaseDirectory = [IO.Path]::GetFullPath((Join-Path $harborReleaseRoot $harborRelease.directory))
  if ([IO.Path]::GetDirectoryName($harborReleaseDirectory) -ne $harborReleaseRoot) { throw 'Invalid Harbor release directory.' }
  $harborSelectedExecutable = Join-Path $harborReleaseDirectory 'Harbor.exe'
  if (-not (Test-Path -LiteralPath $harborSelectedExecutable -PathType Leaf)) { throw 'Selected Harbor release is missing.' }
  $harborPackaged = $harborSelectedExecutable
}
$harborNodeMode = $env:ELECTRON_RUN_AS_NODE
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
try {
$harborUsePackage = (Test-Path -LiteralPath $harborPackaged) -and -not (Test-Path -LiteralPath (Join-Path $harborRoot '.runtime\source-install'))
$harborPackageFile = if ($harborUsePackage) { Join-Path (Split-Path -Parent $harborPackaged) 'resources\app\package.json' } else { Join-Path $harborRoot 'package.json' }
$harborInstalledVersion = (Get-Content -LiteralPath $harborPackageFile -Raw -Encoding UTF8 | ConvertFrom-Json).version
$harborPort = 4317
if ($env:HARBOR_PORT) {
  if (-not [int]::TryParse($env:HARBOR_PORT, [ref]$harborPort) -or $harborPort -lt 1024 -or $harborPort -gt 65535) { throw 'Invalid HARBOR_PORT.' }
}
$harborRunningVersion = $null
try {
  $harborHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$harborPort/api/health" -TimeoutSec 2
  if ($harborHealth.ok -and $harborHealth.name -eq 'codex-harbor') {
    $harborRunningVersion = if ($harborHealth.version -match '^\d+\.\d+\.\d+$') { $harborHealth.version } else { 'unknown' }
  }
} catch { }
$harborCompatible = -not $harborRunningVersion -or $harborRunningVersion -eq $harborInstalledVersion
if ($CheckOnly) {
  [pscustomobject]@{ installedVersion = $harborInstalledVersion; runningVersion = $harborRunningVersion; compatible = $harborCompatible; packaged = [bool]$harborUsePackage } | ConvertTo-Json -Compress
  exit 0
}
if (-not $harborCompatible) {
  Add-Type -AssemblyName System.Windows.Forms
  [void][Windows.Forms.MessageBox]::Show(
    "실행 중인 Harbor: $harborRunningVersion`n설치된 Harbor: $harborInstalledVersion`n`n작업을 저장한 뒤 기존 Harbor에서 Ctrl+Q로 완전히 종료하고 다시 실행하세요. 새로고침이나 일부 창만 닫는 것으로는 버전이 바뀌지 않습니다.`n`n실행 중인 터미널은 자동으로 종료하지 않았습니다.",
    'Harbor 업데이트 실행 안내', [Windows.Forms.MessageBoxButtons]::OK, [Windows.Forms.MessageBoxIcon]::Information)
  exit 0
}
if ($harborUsePackage) {
  Start-Process -FilePath $harborPackaged -WorkingDirectory $harborRoot
  exit 0
}
$harborElectron = Join-Path $harborRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $harborElectron) -or -not (Test-Path -LiteralPath (Join-Path $harborRoot 'dist/server.mjs'))) { throw 'Run Setup-Harbor.cmd first.' }
Start-Process -FilePath $harborElectron -ArgumentList ('"' + $harborRoot + '"') -WorkingDirectory $harborRoot
} finally {
  if ($null -ne $harborNodeMode) { $env:ELECTRON_RUN_AS_NODE = $harborNodeMode }
}
