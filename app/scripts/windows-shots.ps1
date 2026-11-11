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
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(IntPtr cls, string title);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr region, out RECT box);
  [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region, int x, int y);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static void Tap(byte[] mods, byte key) {
    foreach (var m in mods) keybd_event(m, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 2, UIntPtr.Zero);
    for (int i = mods.Length - 1; i >= 0; i--) keybd_event(mods[i], 0, 2, UIntPtr.Zero);
  }
}
"@
[Keys]::SetProcessDPIAware() | Out-Null
# Windows Server turns animation effects off, which browsers report as "reduce motion", and then
# Winku skips its transitions. Turn them on (SPI_SETCLIENTAREAANIMATION) so the bursts show them.
[Keys]::SystemParametersInfo(0x1043, 0, [IntPtr]1, 3) | Out-Null

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

# The shell logs hotkey_hint events here when WINKU_DEBUG_HINT=1.
$hintLog = Join-Path $OutDir "hint.log"
Remove-Item $hintLog -ErrorAction SilentlyContinue
$env:WINKU_DEBUG_HINT = "1"
$env:WINKU_DEBUG_HINT_LOG = $hintLog

$app = Start-Process -FilePath $Exe -PassThru
try {
  Start-Sleep -Seconds 15
  Shot "1-pill"
  # The window region follows the pill's rounded ends, so nothing shows in the corners of its box.
  $hwnd = [Keys]::FindWindow([IntPtr]::Zero, "Winku")
  if ($hwnd -eq [IntPtr]::Zero) { throw "no Winku window" }
  $rgn = [Keys]::CreateRectRgn(0, 0, 0, 0)
  try {
    $kind = [Keys]::GetWindowRgn($hwnd, $rgn)
    $box = New-Object Keys+RECT
    [Keys]::GetRgnBox($rgn, [ref]$box) | Out-Null
    $midY = [int](($box.Top + $box.Bottom) / 2)
    $corner = [Keys]::PtInRegion($rgn, $box.Left + 2, $box.Top + 2)
    $end = [Keys]::PtInRegion($rgn, $box.Left + 2, $midY)
    Write-Host "pill region: kind $kind, box $($box.Left),$($box.Top)-$($box.Right),$($box.Bottom), corner in: $corner, end in: $end"
    # 3 is COMPLEXREGION; a plain rectangle is 2.
    if ($kind -ne 3 -or $corner -or -not $end) { throw "the pill's window region is not rounded" }
  } finally { [Keys]::DeleteObject($rgn) | Out-Null }
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
  # The taps above must not have sent a hint. Then Ctrl+Alt held on its own for about a second:
  # the shell must send hotkey_hint show, and hide on release.
  if (Test-Path $hintLog) { throw "hotkey_hint fired before any hold:`n$(Get-Content $hintLog -Raw)" }
  [Keys]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  [Keys]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 1000
  Shot "4-hint-hold"
  [Keys]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [Keys]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  $lines = @(Get-Content $hintLog -ErrorAction SilentlyContinue)
  Write-Host "hint log: $($lines -join ' | ')"
  if (($lines -join "`n") -ne "hotkey_hint show`nhotkey_hint hide") {
    throw "expected one hotkey_hint show then one hide, got: $($lines -join ' | ')"
  }
} finally {
  Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $app.Id } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
}
