param(
  [string]$HarborRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$DesktopDirectory,
  [string]$PinnedDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$harborShortcutRoot = (Resolve-Path -LiteralPath $HarborRoot).ProviderPath
$harborRepairPins = [bool]$PinnedDirectory -or -not [bool]$DesktopDirectory
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
# Give script-based shortcuts the same identity as the native Harbor window,
# so launching a pinned shortcut groups under that app on the taskbar.
if (-not ('HarborShortcutIdentity' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HarborShortcutIdentity {
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid Format; public uint Id; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] struct PropVariant {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(8)] public IntPtr Value;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
  static extern int SHGetPropertyStoreFromParsingName(string file, IntPtr binding, uint flags, ref Guid iid, out IPropertyStore store);
  public static void Set(string file) {
    var iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(file, IntPtr.Zero, 2, ref iid, out store));
    var key = new PropertyKey { Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5 };
    var value = new PropVariant { Type = 31, Value = Marshal.StringToCoTaskMemUni("org.harbor.workspace") };
    try {
      Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value));
      Marshal.ThrowExceptionForHR(store.Commit());
    } finally {
      Marshal.FreeCoTaskMem(value.Value);
      Marshal.ReleaseComObject(store);
    }
  }
}
'@
}
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
  [HarborShortcutIdentity]::Set($harborShortcutPath)
  if (-not (Test-Path -LiteralPath $harborShortcutPath -PathType Leaf)) { throw 'The desktop shortcut was not saved.' }
  Write-Host "Desktop shortcut ready: $harborShortcutPath"
  if ($harborRepairPins) {
    if (-not $PinnedDirectory) {
      $PinnedDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)) 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'
    }
    if (Test-Path -LiteralPath $PinnedDirectory -PathType Container) {
      $harborShellApp = New-Object -ComObject Shell.Application
      try {
        $harborPinnedFolder = $harborShellApp.Namespace($PinnedDirectory)
        foreach ($harborPinnedFile in (Get-ChildItem -LiteralPath $PinnedDirectory -Filter '*.lnk' -File)) {
          $harborPinnedShortcut = $null
          $harborTemporaryPin = Join-Path ([IO.Path]::GetTempPath()) ('harbor-update-' + [Guid]::NewGuid().ToString('N') + '.lnk')
          try {
            # WScript can fail to read/save a pin with a Unicode filename.
            # Read and preserve its shell properties through an ASCII copy.
            Copy-Item -LiteralPath $harborPinnedFile.FullName -Destination $harborTemporaryPin
            $harborPinnedShortcut = $harborShell.CreateShortcut($harborTemporaryPin)
            # Some Windows taskbar pins store a shell item rather than TargetPath.
            $harborPinnedTarget = $harborPinnedShortcut.TargetPath
            if (-not $harborPinnedTarget) { $harborPinnedTarget = $harborPinnedFolder.ParseName($harborPinnedFile.Name).ExtendedProperty('System.Link.TargetParsingPath') }
            if (-not $harborPinnedTarget) { continue }
            $harborPinnedTarget = [IO.Path]::GetFullPath($harborPinnedTarget)
            $harborReleasePrefix = (Join-Path $harborShortcutRoot 'release') + [IO.Path]::DirectorySeparatorChar
            $harborNativePin = $harborPinnedTarget.StartsWith($harborReleasePrefix, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($harborPinnedTarget) -eq 'Harbor.exe'
            $harborLauncherPin = $harborPinnedTarget -eq $harborPowerShell -and $harborPinnedShortcut.Arguments -eq $harborShortcut.Arguments
            $harborSourcePin = $harborPinnedTarget -eq (Join-Path $harborShortcutRoot 'node_modules\electron\dist\electron.exe') -and $harborPinnedShortcut.Arguments.Trim() -eq ('"' + $harborShortcutRoot + '"')
            if (-not ($harborNativePin -or $harborLauncherPin -or $harborSourcePin)) { continue }
            $harborPinnedShortcut.TargetPath = $harborPowerShell
            $harborPinnedShortcut.Arguments = $harborShortcut.Arguments
            $harborPinnedShortcut.WorkingDirectory = $harborShortcutRoot
            $harborPinnedShortcut.IconLocation = $harborIcon + ',0'
            $harborPinnedShortcut.Description = 'Open the current Harbor version'
            $harborPinnedShortcut.WindowStyle = 7
            $harborPinnedShortcut.Save()
            [HarborShortcutIdentity]::Set($harborTemporaryPin)
            Move-Item -LiteralPath $harborTemporaryPin -Destination $harborPinnedFile.FullName -Force
            $harborTemporaryPin = $null
            Write-Host "Taskbar shortcut updated: $($harborPinnedFile.Name)"
          } finally {
            if ($harborPinnedShortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($harborPinnedShortcut) }
            if ($harborTemporaryPin -and (Test-Path -LiteralPath $harborTemporaryPin)) { Remove-Item -LiteralPath $harborTemporaryPin }
          }
        }
      } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($harborShellApp) }
    }
  }
} finally {
  if ($harborShortcut) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($harborShortcut) }
  if ($harborShell) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($harborShell) }
}
