# Screenshots of the real app on the CI's Windows desktop: the resting pill, then the bar after a
# tap of the summon key (on a fresh profile it shows the Connect form in the bubble). Proves the
# window shape and transparency on real Windows, which the browser mock can't. The open and the
# close are also captured as bursts of frames (open-NN.png, close-NN.png) to check the transition.
param(
  [string]$Exe = "$PSScriptRoot\..\src-tauri\target\release\winku.exe",
  [string]$OutDir = (Join-Path $env:RUNNER_TEMP "winku-shots")
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Keys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Tap(byte[] mods, byte key) {
    foreach (var m in mods) keybd_event(m, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 2, UIntPtr.Zero);
    for (int i = mods.Length - 1; i >= 0; i--) keybd_event(mods[i], 0, 2, UIntPtr.Zero);
  }
}
"@
[Keys]::SetProcessDPIAware() | Out-Null

function Shot([string]$Name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $path = Join-Path $OutDir "$Name.png"
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Host "saved $path ($($bounds.Width)x$($bounds.Height))"
}
Add-Type -AssemblyName System.Windows.Forms

# Frames as fast as the screen can be copied, kept in memory until the burst ends.
function Burst([string]$Name, [int]$Count) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $frames = @()
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  for ($i = 0; $i -lt $Count; $i++) {
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $g.Dispose()
    $frames += , @($bmp, $clock.ElapsedMilliseconds)
  }
  for ($i = 0; $i -lt $frames.Count; $i++) {
    $path = Join-Path $OutDir ("{0}-{1:D2}-{2}ms.png" -f $Name, $i, $frames[$i][1])
    $frames[$i][0].Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames[$i][0].Dispose()
  }
  Write-Host "saved $Count $Name frames over $($clock.ElapsedMilliseconds) ms"
}

$app = Start-Process -FilePath $Exe -PassThru
try {
  Start-Sleep -Seconds 15
  Shot "1-pill"
  # Ctrl+Alt+Space, tapped: opens the bar.
  [Keys]::Tap([byte[]](0x11, 0x12), 0x20)
  Burst "open" 24
  Start-Sleep -Seconds 3
  Shot "2-bar"
  # Esc closes it again.
  [Keys]::Tap([byte[]]@(), 0x1B)
  Burst "close" 24
  Start-Sleep -Seconds 2
  Shot "3-closed"
} finally {
  Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $app.Id } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
}
