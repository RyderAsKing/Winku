# Screenshots of the real app on the CI's Windows desktop: the resting pill, then the bar after a
# tap of the summon key (on a fresh profile it shows the Connect form in the bubble). Proves the
# window shape and transparency on real Windows, which the browser mock can't. The open and the
# close are also captured as bursts of frames (open-NN.png, close-NN.png) to check the transition.
# The open bar is also dragged by its eyes, and must stay where it was dropped once closed.
# Last, text is selected in Notepad and Ctrl+Alt held: the guide must float in its own window just
# above the selection, without taking focus, and go away on release.
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
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hwnd, int x, int y, int w, int h, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hwnd, int index);
}
"@
# Classic Notepad's text box is a Win32 Edit control, which on some systems offers no UI
# Automation text pattern. Then its selection is read the way Winku's fallback reads it: with
# edit control messages (client px, turned into screen px).
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EditSel {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public int cbSize; public int flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  public static string Why = "";
  // The window with the keyboard focus in the thread that owns top, and whether that thread is
  // in menu mode (an Alt tap that reached it).
  public static IntPtr Focused(IntPtr top, out bool inMenu) {
    var info = new GUITHREADINFO(); info.cbSize = Marshal.SizeOf(info);
    inMenu = false;
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(top, IntPtr.Zero), ref info)) return IntPtr.Zero;
    inMenu = (info.flags & 0x4) != 0; // GUI_INMENUMODE
    return info.hwndFocus;
  }
  public static string ClassOf(IntPtr h) { var s = new StringBuilder(128); GetClassName(h, s, 128); return s.ToString(); }
  public static string Text(IntPtr h) {
    int n = (int)SendMessage(h, 0x0E, IntPtr.Zero, IntPtr.Zero); // WM_GETTEXTLENGTH
    var s = new StringBuilder(n + 1); SendMessage(h, 0x0D, (IntPtr)(n + 1), s); // WM_GETTEXT
    return s.ToString();
  }
  static int[] Pos(IntPtr h, int i) {
    if (i < 0) return null;
    long r = SendMessage(h, 0xD6, (IntPtr)i, IntPtr.Zero).ToInt64(); // EM_POSFROMCHAR
    if (r == -1) return null;
    return new int[] { (short)(r & 0xFFFF), (short)((r >> 16) & 0xFFFF) };
  }
  // The first selected line on screen as x, y, w, h, or null with the reason in Why.
  public static int[] FirstLine(IntPtr h) {
    long sel = SendMessage(h, 0xB0, IntPtr.Zero, IntPtr.Zero).ToInt64(); // EM_GETSEL
    int start = (int)(sel & 0xFFFF), end = (int)((sel >> 16) & 0xFFFF);
    if (start == end) { Why = "empty selection at " + start; return null; }
    int line = (int)SendMessage(h, 0xC9, (IntPtr)start, IntPtr.Zero); // EM_LINEFROMCHAR
    int lineStart = (int)SendMessage(h, 0xBB, (IntPtr)line, IntPtr.Zero); // EM_LINEINDEX
    int lineLength = (int)SendMessage(h, 0xC1, (IntPtr)start, IntPtr.Zero); // EM_LINELENGTH
    int firstEnd = Math.Min(end, lineStart + lineLength);
    var a = Pos(h, start); var b = Pos(h, firstEnd);
    var n = Pos(h, (int)SendMessage(h, 0xBB, (IntPtr)(line + 1), IntPtr.Zero));
    Why = string.Format("range {0}..{1}, line {2} from {3} length {4}, start {5}, first end {6}, next line {7}",
      start, end, line, lineStart, lineLength, Fmt(a), Fmt(b), Fmt(n));
    if (a == null || b == null || n == null || b[1] != a[1] || b[0] <= a[0] || n[1] <= a[1]) return null;
    var o = new POINT(); ClientToScreen(h, ref o);
    return new int[] { o.X + a[0], o.Y + a[1], b[0] - a[0], n[1] - a[1] };
  }
  static string Fmt(int[] p) { return p == null ? "none" : p[0] + "," + p[1]; }
}
"@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
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

# The shell logs hotkey_hint events here when WINKU_DEBUG_HINT=1, with each selection query's
# answer and where it came from, and why each guide floated or showed beside Winku.
$hintLog = Join-Path $OutDir "hint.log"
function Show-HintLog([string]$Title) {
  Write-Host "${Title}:"
  @(Get-Content $hintLog -ErrorAction SilentlyContinue | Where-Object { $_ }) | ForEach-Object { Write-Host "  $_" }
}
Remove-Item $hintLog -ErrorAction SilentlyContinue
$env:WINKU_DEBUG_HINT = "1"
$env:WINKU_DEBUG_HINT_LOG = $hintLog

$app = Start-Process -FilePath $Exe -PassThru
try {
  # Wait for the pill: its window exists and has been clipped to the pill's shape (3 is
  # COMPLEXREGION), then a moment for the eyes to draw and come to rest.
  $ready = $false
  for ($i = 0; $i -lt 120 -and -not $ready; $i++) {
    Start-Sleep -Milliseconds 250
    $hwnd = [Keys]::FindWindow([IntPtr]::Zero, "Winku")
    if ($hwnd -eq [IntPtr]::Zero) { continue }
    $rgn = [Keys]::CreateRectRgn(0, 0, 0, 0)
    $ready = [Keys]::GetWindowRgn($hwnd, $rgn) -eq 3
    [Keys]::DeleteObject($rgn) | Out-Null
  }
  if (-not $ready) { throw "the pill did not show within 30 s" }
  Start-Sleep -Seconds 3
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
  # (A tap still starts a selection query when Ctrl+Alt go down; its log line is fine.)
  $early = @(Get-Content $hintLog -ErrorAction SilentlyContinue | Where-Object { $_ -and $_ -notlike "selection query *" })
  if ($early) { Show-HintLog "hint log"; throw "the guide showed before any hold: $($early -join ' | ')" }
  [Keys]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  [Keys]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 1000
  Shot "4-hint-hold"
  [Keys]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [Keys]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  Show-HintLog "hint log after the first hold"
  $lines = @(Get-Content $hintLog -ErrorAction SilentlyContinue | Where-Object { $_ -like "hotkey_hint *" })
  if (($lines -join "`n") -ne "hotkey_hint show`nhotkey_hint hide") {
    throw "expected one hotkey_hint show then one hide, got: $($lines -join ' | ')"
  }

  # The floating guide. Notepad low enough on the screen that there is room above its first line.
  $notepad = Start-Process notepad -PassThru
  $pad = [IntPtr]::Zero
  for ($i = 0; $i -lt 40 -and $pad -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 250
    $pad = [Win]::FindWindow("Notepad", [NullString]::Value)
  }
  if ($pad -eq [IntPtr]::Zero) { throw "Notepad did not open within 10 s" }
  [Win]::MoveWindow($pad, 200, 420, 900, 400, $true) | Out-Null
  # Notepad usually opens in front. If not, a tap of Alt first lets this process hand it the
  # foreground. An Alt tap that reaches Notepad puts it in menu mode, where the first typed
  # letter is taken as a menu key and lost; Esc leaves menu mode.
  if ([Win]::GetForegroundWindow() -ne $pad) {
    [Keys]::Tap([byte[]]@(), 0x12)
    [Win]::SetForegroundWindow($pad) | Out-Null
  }
  for ($i = 0; $i -lt 40 -and [Win]::GetForegroundWindow() -ne $pad; $i++) { Start-Sleep -Milliseconds 100 }
  if ([Win]::GetForegroundWindow() -ne $pad) { throw "Notepad is not in front (foreground $([Win]::GetForegroundWindow()), Notepad $pad)" }
  Start-Sleep -Milliseconds 300
  $inMenu = $false
  $edit = [EditSel]::Focused($pad, [ref]$inMenu)
  if ($inMenu) { Write-Host "Notepad is in menu mode; Esc leaves it"; [Keys]::Tap([byte[]]@(), 0x1B); Start-Sleep -Milliseconds 200 }
  $editClass = if ($edit -ne [IntPtr]::Zero) { [EditSel]::ClassOf($edit) } else { "none" }
  Write-Host "Notepad's focused control: $editClass"
  [System.Windows.Forms.SendKeys]::SendWait("Winku floating guide check{ENTER}a second line")
  Start-Sleep -Milliseconds 200
  if ($edit -ne [IntPtr]::Zero) {
    $typed = [EditSel]::Text($edit)
    Write-Host "Notepad's text: $($typed -replace "`r`n", '\n')"
    if (-not $typed.StartsWith("Winku floating guide check")) { Write-Host "::warning::the text typed into Notepad came out as '$typed'" }
  }
  # Ctrl+Home, then Shift+End: the first line is selected.
  [Keys]::Tap([byte[]](0x11), 0x24)
  [Keys]::Tap([byte[]](0x10), 0x23)
  Start-Sleep -Milliseconds 300
  # Where the selection is, asked the same way Winku asks (UI Automation, physical px), then as
  # Winku's fallback asks a standard edit control (window messages).
  $line = $null
  try {
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    $text = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $rects = $text.GetSelection()[0].GetBoundingRectangles()
    if ($rects.Count -gt 0) { $line = $rects[0] }
  } catch { Write-Host "could not read Notepad's selection through UI Automation: $_" }
  if (-not $line -and $editClass -match '^(Edit|RichEdit)') {
    $r = [EditSel]::FirstLine($edit)
    Write-Host "Notepad's selection through edit control messages: $([EditSel]::Why)"
    if ($r) { $line = [pscustomobject]@{ X = $r[0]; Y = $r[1]; Width = $r[2]; Height = $r[3] } }
  }
  $padRect = [Mouse]::Rect($pad)
  Write-Host "notepad: $($padRect.Left),$($padRect.Top)-$($padRect.Right),$($padRect.Bottom); selection's first line: $(if ($line) { "$($line.X),$($line.Y) $($line.Width)x$($line.Height)" } else { 'unknown' })"
  Shot "5-notepad-selection"

  Set-Content -Path $hintLog -Value $null
  # The first hold creates the guide's window, and Winku's first UI Automation query can miss the
  # 450 ms hold delay, so a second hold is allowed.
  $guide = [IntPtr]::Zero; $shown = $null; $hidden = $false; $front = $null
  for ($attempt = 1; $attempt -le 2 -and -not $shown; $attempt++) {
    [Keys]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [Keys]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt 4000 -and -not $shown) {
      Start-Sleep -Milliseconds 100
      $guide = [Keys]::FindWindow([IntPtr]::Zero, "Winku guide")
      if ($guide -ne [IntPtr]::Zero -and [Win]::IsWindowVisible($guide)) {
        Start-Sleep -Milliseconds 200
        $shown = [Mouse]::Rect($guide)
        $front = [Win]::GetForegroundWindow()
        Write-Host "attempt ${attempt}: guide shown after $($clock.ElapsedMilliseconds) ms"
        Shot "6-floating-guide"
      }
    }
    if (-not $shown) {
      Write-Host "attempt ${attempt}: no floating guide within 4 s (window $(if ($guide -eq [IntPtr]::Zero) { 'not created' } else { 'hidden' }))"
      Shot "6-floating-guide-missing-$attempt"
    }
    [Keys]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [Keys]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 600
  }
  if ($guide -ne [IntPtr]::Zero) { $hidden = -not [Win]::IsWindowVisible($guide) }
  Shot "7-floating-guide-released"
  $lines = @(Get-Content $hintLog -ErrorAction SilentlyContinue | Where-Object { $_ })
  Show-HintLog "hint log for the Notepad holds"
  if (-not $shown) { throw "the guide did not float over the Notepad selection (the hint log above says why)" }
  $exStyle = [Win]::GetWindowLong($guide, -20)
  Write-Host ("guide window: {0},{1}-{2},{3}; extended style 0x{4:X8}; foreground after showing: {5} (Notepad {6})" -f $shown.Left, $shown.Top, $shown.Right, $shown.Bottom, $exStyle, $front, $pad)
  if ($front -ne $pad) { throw "the guide took the foreground from Notepad" }
  # WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW (out of Alt+Tab) and WS_EX_TRANSPARENT (clicks pass through).
  foreach ($flag in @(@(0x08000000, "WS_EX_NOACTIVATE"), @(0x80, "WS_EX_TOOLWINDOW"), @(0x20, "WS_EX_TRANSPARENT"))) {
    if (($exStyle -band $flag[0]) -eq 0) { throw "the guide window lacks $($flag[1])" }
  }
  if ($line) {
    $centre = $line.X + $line.Width / 2
    $guideCentre = ($shown.Left + $shown.Right) / 2
    if ($shown.Bottom -gt $line.Y) { throw "the guide (bottom $($shown.Bottom)) is not above the selection (top $($line.Y))" }
    if (($line.Y - $shown.Bottom) -gt 40) { throw "the guide (bottom $($shown.Bottom)) is not just above the selection (top $($line.Y))" }
    if ([math]::Abs($guideCentre - $centre) -gt 2 -and $shown.Left -gt 0) { throw "the guide (centre $guideCentre) is not centred on the selection (centre $centre)" }
  } elseif ($shown.Bottom -gt $padRect.Top + 200 -or $shown.Bottom -lt $padRect.Top - 40) {
    throw "the guide (bottom $($shown.Bottom)) is not just above Notepad's first line (window top $($padRect.Top))"
  }
  if (-not $hidden) { throw "the guide window still shows after Ctrl+Alt was released" }
  if ($lines -contains "hotkey_hint show") { Write-Host "note: one hold showed the guide beside the eyes (the hint log above says why)" }

  # Idle memory with the guide's second web view alive (SPEC §4: 150 MB), counted like
  # measure-memory.ps1: private working set of the whole process tree.
  Start-Sleep -Seconds 5
  $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add($app.Id)
  $all = Get-CimInstance Win32_Process
  for ($i = 0; $i -lt $ids.Count; $i++) {
    $all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { $ids.Add([int]$_.ProcessId) }
  }
  $private = (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains [int]$_.IDProcess } |
    Measure-Object -Property WorkingSetPrivate -Sum).Sum / 1MB
  Write-Host ("idle memory after the floating guide: {0:N1} MB private working set over {1} processes (budget 150 MB)" -f $private, $ids.Count)
  if ($private -gt 150) { Write-Host "::warning::idle memory after the floating guide is $([math]::Round($private, 1)) MB, over the 150 MB budget" }
} finally {
  if ($notepad) { Stop-Process -Id $notepad.Id -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $app.Id } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
}
