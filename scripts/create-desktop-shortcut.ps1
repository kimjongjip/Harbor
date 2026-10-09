param(
  [string]$HarborRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$DesktopDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$harborShortcutRoot = (Resolve-Path -LiteralPath $HarborRoot).ProviderPath
$harborLauncher = Join-Path $harborShortcutRoot 'Start-Harbor-Desktop.ps1'
$harborIcon = Join-Path $harborShortcutRoot 'desktop\icon.ico'
foreach ($harborFile in @($harborLauncher, $harborIcon)) {
  if (-not (Test-Path -LiteralPath $harborFile -PathType Leaf)) { throw "Shortcut file is missing: $harborFile" }
}
if (-not $DesktopDirectory) {
  # Use the Windows known folder, including a Desktop redirected to OneDrive.
  $DesktopDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
}
if (-not $DesktopDirectory) { throw 'Cannot locate the Windows Desktop folder.' }
New-Item -ItemType Directory -Path $DesktopDirectory -Force | Out-Null
$harborShortcutPath = Join-Path (Resolve-Path -LiteralPath $DesktopDirectory).ProviderPath 'Harbor.lnk'
$harborPowerShell = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::System)) 'WindowsPowerShell\v1.0\powershell.exe'
$harborShell = $null
$harborShortcut = $null
try {
  $harborShell = New-Object -ComObject WScript.Shell
  $harborShortcut = $harborShell.CreateShortcut($harborShortcutPath)
  $harborShortcut.TargetPath = $harborPowerShell
  $harborShortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $harborLauncher + '"'
  $harborShortcut.WorkingDirectory = $harborShortcutRoot
  $harborShortcut.IconLocation = $harborIcon + ',0'
  $harborShortcut.Description = 'Open Harbor'
  $harborShortcut.WindowStyle = 7
  $harborShortcut.Save()
  if (-not (Test-Path -LiteralPath $harborShortcutPath -PathType Leaf)) { throw 'The desktop shortcut was not saved.' }
  Write-Host "Desktop shortcut ready: $harborShortcutPath"
} finally {
  if ($harborShortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($harborShortcut) }
  if ($harborShell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($harborShell) }
}
