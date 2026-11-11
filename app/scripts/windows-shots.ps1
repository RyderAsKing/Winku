# Screenshots of the real app on the CI's Windows desktop: the resting pill, then the bar after a
# tap of the summon key (on a fresh profile it shows the Connect form in the bubble). Proves the
# window shape and transparency on real Windows, which the browser mock can't. The open and the
# close are also captured as bursts of frames (open-NN.png, close-NN.png) to check the transition.
# The open bar is also dragged by its eyes, and must stay where it was dropped once closed.
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
  public static void Tap(byte[] mods, byte key) {
    foreach (var m in mods) keybd_event(m, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 0, UIntPtr.Zero);
    keybd_event(key, 0, 2, UIntPtr.Zero);
    for (int i = mods.Length - 1; i >= 0; i--) keybd_event(mods[i], 0, 2, UIntPtr.Zero);
  }
}
"@
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Mouse {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(IntPtr cls, string title);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  public static RECT Rect(IntPtr hwnd) { RECT r; GetWindowRect(hwnd, out r); return r; }
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
  # Ctrl+Alt+Space, tapped: opens the bar.
  [Keys]::Tap([byte[]](0x11, 0x12), 0x20)
  Burst "open" 24
  Start-Sleep -Seconds 3
  Shot "2-bar"
  # Drag the open bar by its eyes. On a fresh profile the pill rests at the right edge with the
  # bar growing left, so the eyes are at the window's top-right.
  $hwnd = [Mouse]::FindWindow([IntPtr]::Zero, "Winku")
  if ($hwnd -eq [IntPtr]::Zero) { throw "no Winku window" }
  $scale = [Mouse]::GetDpiForWindow($hwnd) / 96.0
  $before = [Mouse]::Rect($hwnd)
  $x = [int]($before.Right - 46 * $scale); $y = [int]($before.Top + 28 * $scale)
  [Mouse]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 200
  [Mouse]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)
  for ($i = 1; $i -le 20; $i++) {
    [Mouse]::SetCursorPos($x - 10 * $i, $y + 8 * $i) | Out-Null
    Start-Sleep -Milliseconds 25
  }
  [Mouse]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 800
  $moved = [Mouse]::Rect($hwnd)
  Write-Host "bar drag: window $($before.Left),$($before.Top) -> $($moved.Left),$($moved.Top)"
  Shot "2b-bar-dragged"
  if (($before.Left - $moved.Left) -lt 80 -or ($moved.Top - $before.Top) -lt 60) {
    throw "dragging the open bar by its eyes did not move it"
  }
  # Esc closes it again.
  [Keys]::Tap([byte[]]@(), 0x1B)
  Burst "close" 24
  Start-Sleep -Seconds 2
  Shot "3-closed"
  # Closing keeps the eyes where the open bar was dropped.
  $closed = [Mouse]::Rect($hwnd)
  Write-Host "after close: window $($closed.Left),$($closed.Top)"
  if ($closed.Left -ne $moved.Left -or $closed.Top -ne $moved.Top) {
    throw "closing the bar moved the eyes back from where they were dropped"
  }
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
