# How much Winku costs everything else on the desktop. Run after a release build.
#
# 1. Without Winku: idle CPU of dwm.exe, and the time to move a test window 300 times
#    (raw SetWindowPos, then one DwmFlush per move so composition cost shows too).
# 2. With Winku resting as the pill (smoke mode): the same, plus CPU per Winku process and how
#    often the main window was shown, hidden, moved or resized while nothing was happening.
# 3. With a Chromium window in front (Edge in app mode, a page that changes 400 text nodes every
#    frame, like a busy Electron app): Edge's CPU and the time to move its window, before and
#    after a summon of the bar over it, then after a direct UI Automation query of the focused
#    element. Chromium builds its accessibility tree once a UIA/MSAA client asks for it, and
#    keeps it until restart; that shows up as Edge CPU.
#
# Fails the job only when moving a window with Winku running takes more than twice as long as
# without it and at least a second longer (300 moves normally take well under a second, so this
# is far outside run-to-run noise). Everything else is reported, with warnings.
param(
  [string]$Exe = "$PSScriptRoot\..\src-tauri\target\release\winku.exe",
  [int]$Moves = 300,
  [int]$SettleSeconds = 20,
  [int]$IdleSeconds = 20,
  [int]$EdgeSeconds = 10
)
$ErrorActionPreference = "Stop"
$temp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class Probe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();

  const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
  const byte VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SPACE = 0x20, VK_F24 = 0x87;
  const uint KEYUP = 0x2;

  public static Form TestForm;

  public static IntPtr NewForm() {
    TestForm = new Form();
    TestForm.Text = "perf-probe";
    TestForm.StartPosition = FormStartPosition.Manual;
    TestForm.Location = new Point(100, 120);
    TestForm.Size = new Size(480, 360);
    TestForm.Show();
    Application.DoEvents();
    return TestForm.Handle;
  }

  public static void Pump() { if (TestForm != null) Application.DoEvents(); }

  // A key tap first makes this process the last one to send input, which lifts the foreground
  // lock. F24, not Alt: an Alt tap would put the focused window into its menu loop.
  public static bool Focus(IntPtr h) {
    keybd_event(VK_F24, 0, 0, UIntPtr.Zero);
    keybd_event(VK_F24, 0, KEYUP, UIntPtr.Zero);
    SetForegroundWindow(h);
    for (int i = 0; i < 20 && GetForegroundWindow() != h; i++) { Pump(); Thread.Sleep(50); }
    return GetForegroundWindow() == h;
  }

  public static bool IsForeground(IntPtr h) { return GetForegroundWindow() == h; }

  // DwmFlush waits for the next composition pass; in a session with no display it can block
  // for good. True when one call returns within 2 s.
  public static bool FlushWorks() {
    var t = new Thread(() => DwmFlush());
    t.IsBackground = true;
    t.Start();
    return t.Join(2000);
  }

  // Moves the window back and forth n times; milliseconds.
  public static double Move(IntPtr h, int n, bool flush) {
    RECT r; GetWindowRect(h, out r);
    var sw = Stopwatch.StartNew();
    for (int i = 0; i < n; i++) {
      int x = r.Left + (i % 50) * 4;
      SetWindowPos(h, IntPtr.Zero, x, r.Top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
      Pump();
      if (flush) DwmFlush();
    }
    double ms = sw.Elapsed.TotalMilliseconds;
    SetWindowPos(h, IntPtr.Zero, r.Left, r.Top, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
    Pump();
    return ms;
  }

  // Top-level window of process pid titled title, or zero.
  public static IntPtr FindWindow(int pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var s = new System.Text.StringBuilder(256);
      GetWindowText(h, s, 256);
      if (s.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Rect(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    return string.Format("{0}x{1} at {2},{3}", r.Right - r.Left, r.Bottom - r.Top, r.Left, r.Top);
  }

  // Polls the window every 20 ms for ms; counts visibility flips and rect changes.
  public static int[] Watch(IntPtr h, int ms) {
    int flips = 0, moves = 0;
    bool vis = IsWindowVisible(h);
    RECT last; GetWindowRect(h, out last);
    var sw = Stopwatch.StartNew();
    while (sw.ElapsedMilliseconds < ms) {
      Thread.Sleep(20);
      bool v = IsWindowVisible(h);
      if (v != vis) { flips++; vis = v; }
      RECT r; GetWindowRect(h, out r);
      if (r.Left != last.Left || r.Top != last.Top || r.Right != last.Right || r.Bottom != last.Bottom) { moves++; last = r; }
    }
    return new int[] { flips, moves };
  }

  // The window's rect grown by pad px on each side, as x, y, w, h.
  public static int[] Around(IntPtr h, int pad) {
    RECT r; GetWindowRect(h, out r);
    return new int[] { r.Left - pad, r.Top - pad, r.Right - r.Left + 2 * pad, r.Bottom - r.Top + 2 * pad };
  }

  // Screen pixels of a rect (x, y, w, h), saved as a PNG too.
  public static Bitmap Grab(int[] a, string path) {
    var b = new Bitmap(a[2], a[3]);
    using (var g = Graphics.FromImage(b)) g.CopyFromScreen(a[0], a[1], 0, 0, new Size(a[2], a[3]));
    b.Save(path, System.Drawing.Imaging.ImageFormat.Png);
    return b;
  }

  // Share of pixels that differ between two grabs of the same rect, inside and outside the
  // inner rect (the window itself, pad px in from each edge).
  public static double[] Differ(Bitmap a, Bitmap b, int pad) {
    int inner = 0, innerN = 0, outer = 0, outerN = 0;
    for (int y = 0; y < a.Height; y++) for (int x = 0; x < a.Width; x++) {
      bool inside = x >= pad && y >= pad && x < a.Width - pad && y < a.Height - pad;
      bool diff = a.GetPixel(x, y).ToArgb() != b.GetPixel(x, y).ToArgb();
      if (inside) { innerN++; if (diff) inner++; } else { outerN++; if (diff) outer++; }
    }
    return new double[] { Math.Round(100.0 * inner / Math.Max(innerN, 1), 1), Math.Round(100.0 * outer / Math.Max(outerN, 1), 1) };
  }

  // Taps Ctrl+Alt+Space, Winku's default summon hotkey.
  public static void Summon() {
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
    keybd_event(VK_SPACE, 0, 0, UIntPtr.Zero);
    Thread.Sleep(40);
    keybd_event(VK_SPACE, 0, KEYUP, UIntPtr.Zero);
    keybd_event(VK_MENU, 0, KEYUP, UIntPtr.Zero);
    keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
  }
}
"@

function Get-Tree([int]$RootId) {
  $all = Get-CimInstance Win32_Process
  $ids = [System.Collections.Generic.List[int]]::new()
  $ids.Add($RootId)
  for ($i = 0; $i -lt $ids.Count; $i++) {
    $all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { $ids.Add([int]$_.ProcessId) }
  }
  $ids
}

function Get-CpuSeconds($Processes) {
  $sum = 0.0
  foreach ($p in $Processes) {
    try { $p.Refresh(); $sum += $p.TotalProcessorTime.TotalSeconds } catch {}
  }
  $sum
}

# CPU per process over $Seconds, as % of one core, while $During runs (or sleeping). $List
# gives the processes; it is called at both ends, so processes that start in between count
# from their start and ones that exit drop out.
function Measure-Cpu([scriptblock]$List, [int]$Seconds, [scriptblock]$During) {
  $start = Get-Date
  $before = @{}
  foreach ($p in & $List) { try { $before[$p.Id] = @($p.StartTime, $p.TotalProcessorTime.TotalSeconds) } catch {} }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $extra = if ($During) { & $During } else { Start-Sleep -Seconds $Seconds }
  $elapsed = $watch.Elapsed.TotalSeconds
  $rows = foreach ($p in & $List) {
    try { $started = $p.StartTime; $after = $p.TotalProcessorTime.TotalSeconds } catch { continue }
    if ($before.ContainsKey($p.Id) -and $before[$p.Id][0] -eq $started) { $base = $before[$p.Id][1] }
    elseif ($started -gt $start) { $base = 0 }
    else { continue }
    [pscustomobject]@{ Name = $p.ProcessName; Pid = $p.Id; Cpu = [math]::Round(100 * ($after - $base) / $elapsed, 2) }
  }
  [pscustomobject]@{ Rows = @($rows); Extra = $extra; Seconds = [math]::Round($elapsed, 1) }
}

function Sum-Cpu($m, [string]$Name) {
  [math]::Round((($m.Rows | Where-Object { -not $Name -or $_.Name -eq $Name }) | Measure-Object Cpu -Sum).Sum, 2)
}

$clock = [Diagnostics.Stopwatch]::StartNew()
function Step([string]$Text) { Write-Host ("[{0,5:N1}s] {1}" -f $clock.Elapsed.TotalSeconds, $Text) }

$dwm = { @(Get-Process dwm -ErrorAction SilentlyContinue) }
Step "dwm processes: $((& $dwm).Count)"
$flush = [Probe]::FlushWorks()
Step "DwmFlush returns: $flush"
$results = [ordered]@{}
$uiaKey = "UIA read of Edge after the summon (text = its accessibility was already on)"

# ── 1. Without Winku ───────────────────────────────────────────────────────────
Step "opening the test window"
$form = [Probe]::NewForm()
$null = [Probe]::Focus($form)
$results["Foreground during moves (no Winku)"] = [Probe]::IsForeground($form)
$null = [Probe]::Move($form, 50, $false) # warm up
$results["Move test window x$Moves, raw (no Winku) ms"] = [math]::Round([Probe]::Move($form, $Moves, $false), 0)
if ($flush) { $results["Move test window x$Moves, DwmFlush (no Winku) ms"] = [math]::Round([Probe]::Move($form, $Moves, $true), 0) }
Step "moves without Winku done"
$idle0 = Measure-Cpu $dwm $IdleSeconds
Step "idle sample without Winku done"
$results["dwm.exe idle CPU % (no Winku)"] = Sum-Cpu $idle0

# ── 2. With Winku resting ─────────────────────────────────────────────────────
$env:WINKU_SMOKE = "1"
$env:WINKU_SMOKE_STAY = "1"
$out = Join-Path $temp "winku-probe.out"
$app = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $out
Step "started Winku ($($app.Id)), settling"
Start-Sleep -Seconds $SettleSeconds
$main = [Probe]::FindWindow($app.Id, "Winku")
$results["Winku main window"] = if ($main -ne [IntPtr]::Zero) { [Probe]::Rect($main) } else { "not found" }

# The resting pill and 24 px around it, for the transparency and shadow check at the end.
$pad = 24
$pillShot = $null
if ($main -ne [IntPtr]::Zero) {
  $pillArea = [Probe]::Around($main, $pad)
  $pillShot = [Probe]::Grab($pillArea, (Join-Path $temp "probe-pill.png"))
}

$winkuIds = @(Get-Tree $app.Id)
$winkuAndDwm = { @($winkuIds | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }) + (& $dwm) }
$idle1 = Measure-Cpu $winkuAndDwm $IdleSeconds {
  if ($main -ne [IntPtr]::Zero) { [Probe]::Watch($main, $IdleSeconds * 1000) } else { Start-Sleep -Seconds $IdleSeconds; @(0, 0) }
}
Step "idle sample with Winku done"
$idle1.Rows | Sort-Object Cpu -Descending | Format-Table -AutoSize | Out-String | Write-Host
$results["Winku tree idle CPU % (all processes)"] = [math]::Round((Sum-Cpu $idle1) - (Sum-Cpu $idle1 "dwm"), 2)
$results["dwm.exe idle CPU % (Winku resting)"] = Sum-Cpu $idle1 "dwm"
$results["Main window show/hide flips while idle"] = $idle1.Extra[0]
$results["Main window moves/resizes while idle"] = $idle1.Extra[1]

$null = [Probe]::Focus($form)
$results["Foreground during moves (Winku)"] = [Probe]::IsForeground($form)
$null = [Probe]::Move($form, 50, $false)
$moveWinku = Measure-Cpu $winkuAndDwm 0 {
  [pscustomobject]@{
    Raw   = [math]::Round([Probe]::Move($form, $Moves, $false), 0)
    Flush = if ($flush) { [math]::Round([Probe]::Move($form, $Moves, $true), 0) } else { "skipped" }
  }
}
$results["Move test window x$Moves, raw (Winku) ms"] = $moveWinku.Extra.Raw
$results["Move test window x$Moves, DwmFlush (Winku) ms"] = $moveWinku.Extra.Flush
$results["Winku tree CPU % during moves"] = [math]::Round((Sum-Cpu $moveWinku) - (Sum-Cpu $moveWinku "dwm"), 2)
$results["dwm.exe CPU % during moves (Winku)"] = Sum-Cpu $moveWinku "dwm"
Step "moves with Winku done"
[Probe]::TestForm.Close()

# ── 3. A Chromium window in front ─────────────────────────────────────────────
$edgeExe = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if ($edgeExe) {
  $page = Join-Path $temp "winku-probe.html"
  @"
<!doctype html><title>probe</title>
<textarea id=t rows=4 cols=60>The quick brown fox jumps over the lazy dog</textarea><div id=g></div>
<script>
const t = document.getElementById("t"); t.focus(); t.select();
const g = document.getElementById("g"), spans = [];
for (let i = 0; i < 400; i++) { const s = document.createElement("span"); s.textContent = "x "; g.appendChild(s); spans.push(s); }
let n = 0;
(function tick() { n++; for (let i = 0; i < spans.length; i++) spans[i].textContent = ((n + i) % 97) + " "; requestAnimationFrame(tick); })();
</script>
"@ | Set-Content -Path $page -Encoding utf8
  $edgeProfile = Join-Path $temp "winku-probe-edge"
  $url = "file:///" + ($page -replace '\\', '/')
  Start-Process -FilePath $edgeExe -ArgumentList @("--user-data-dir=$edgeProfile", "--no-first-run", "--no-default-browser-check", "--window-position=200,150", "--window-size=900,600", "--app=$url") | Out-Null
  Step "started Edge"
  Start-Sleep -Seconds 10
  $edgeWindow = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($edgeWindow) {
    $edgeHwnd = $edgeWindow.MainWindowHandle
    $edge = { @(Get-Process msedge -ErrorAction SilentlyContinue) }
    $results["Edge in front"] = [Probe]::Focus($edgeHwnd)
    $results["Edge CPU % before summon"] = Sum-Cpu (Measure-Cpu $edge $EdgeSeconds)
    $results["Move Edge window x$Moves, raw, before summon ms"] = [math]::Round([Probe]::Move($edgeHwnd, $Moves, $false), 0)

    Step "Edge sampled before summon"
    [Probe]::Summon()
    Start-Sleep -Milliseconds 1500
    $results["Winku main window after summon"] = if ($main -ne [IntPtr]::Zero) { [Probe]::Rect($main) } else { "not found" }
    [Probe]::Summon()
    Start-Sleep -Milliseconds 1500
    $null = [Probe]::Focus($edgeHwnd)
    Start-Sleep -Seconds 2
    $results["Edge CPU % after summon"] = Sum-Cpu (Measure-Cpu $edge $EdgeSeconds)
    $results["Move Edge window x$Moves, raw, after summon ms"] = [math]::Round([Probe]::Move($edgeHwnd, $Moves, $false), 0)

    Step "Edge sampled after summon"
    # The same query Winku made at summon before this fix, straight from here. Chromium answers
    # with its real elements (the textarea's text pattern) only when its accessibility tree is
    # already on, i.e. when an earlier query (Winku's) switched it on; otherwise it answers with
    # a bare pane and switches the tree on now.
    try {
      $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
      $pattern = $null
      if ($focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
        $results[$uiaKey] = ($pattern.GetSelection() | ForEach-Object { $_.GetText(-1) }) -join " "
      } else {
        $results[$uiaKey] = "(no text pattern on $($focused.Current.ControlType.ProgrammaticName))"
      }
    } catch { $results[$uiaKey] = "failed: $($_.Exception.Message)" }
    Start-Sleep -Seconds 2
    $results["Edge CPU % after a direct UIA query"] = Sum-Cpu (Measure-Cpu $edge $EdgeSeconds)
    $results["Move Edge window x$Moves, raw, after UIA ms"] = [math]::Round([Probe]::Move($edgeHwnd, $Moves, $false), 0)
  } else {
    $results["Edge in front"] = "no Edge window"
  }
  Step "Edge done"
  Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
} else {
  $results["Edge in front"] = "Edge not installed"
}

Get-Tree $app.Id | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

# Same area with Winku gone. Transparent eyes change only part of their rect; an opaque box
# changes all of it. Changes outside the rect would be a shadow or border.
if ($pillShot) {
  Start-Sleep -Seconds 2
  $bare = [Probe]::Grab($pillArea, (Join-Path $temp "probe-pill-bare.png"))
  $diff = [Probe]::Differ($pillShot, $bare, $pad)
  $results["Pill pixels changed inside its rect %"] = $diff[0]
  $results["Pixels changed in the $pad px around the pill %"] = $diff[1]
}

# ── Report ────────────────────────────────────────────────────────────────────
$table = $results.GetEnumerator() | ForEach-Object { [pscustomobject]@{ Measure = $_.Key; Value = $_.Value } }
$table | Format-Table -AutoSize -Wrap | Out-String -Width 200 | Write-Host
if ($env:GITHUB_STEP_SUMMARY) {
  "### Perf probe on windows-latest`n" | Out-File $env:GITHUB_STEP_SUMMARY -Append
  "| Measure | Value |`n|---|---|" | Out-File $env:GITHUB_STEP_SUMMARY -Append
  $table | ForEach-Object { "| $($_.Measure) | $($_.Value) |" } | Out-File $env:GITHUB_STEP_SUMMARY -Append
}

$raw0 = $results["Move test window x$Moves, raw (no Winku) ms"]
$raw1 = $results["Move test window x$Moves, raw (Winku) ms"]
if ($results["Main window show/hide flips while idle"] -gt 0) { Write-Host "::warning::The main window was shown or hidden $($results["Main window show/hide flips while idle"]) times while idle" }
if ($results[$uiaKey] -eq "The quick brown fox jumps over the lazy dog") {
  Write-Host "::warning::Summoning the bar over Edge switched on Edge's accessibility tree"
}
$before = $results["Edge CPU % before summon"]; $after = $results["Edge CPU % after summon"]
if ($before -ne $null -and $after -gt 1.5 * $before -and $after - $before -gt 5) {
  Write-Host "::warning::Edge CPU went from $before% to $after% after summoning the bar over it"
}
if ($raw1 -gt 2 * $raw0 -and $raw1 - $raw0 -gt 1000) {
  throw "Moving a window with Winku running took $raw1 ms against $raw0 ms without it"
}
