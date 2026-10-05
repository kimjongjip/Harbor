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
if ((Test-Path -LiteralPath $harborPackaged) -and -not (Test-Path -LiteralPath (Join-Path $harborRoot '.runtime\source-install'))) {
  Start-Process -FilePath $harborPackaged -WorkingDirectory $harborRoot
  exit 0
}
$harborElectron = Join-Path $harborRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $harborElectron) -or -not (Test-Path -LiteralPath (Join-Path $harborRoot 'dist/server.mjs'))) { throw 'Run Setup-Harbor.cmd first.' }
Start-Process -FilePath $harborElectron -ArgumentList ('"' + $harborRoot + '"') -WorkingDirectory $harborRoot
} finally {
  if ($null -ne $harborNodeMode) { $env:ELECTRON_RUN_AS_NODE = $harborNodeMode }
}
