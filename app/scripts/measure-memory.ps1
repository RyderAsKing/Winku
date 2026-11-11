# Starts the release build in smoke mode, lets it settle, and reports idle memory for the
# whole process tree: winku.exe, winku-engine.exe and the WebView2 processes it spawned.
# Then samples CPU time over a quiet window with the resting pill showing (SPEC §4: close to 0%).
param(
  [string]$Exe = "$PSScriptRoot\..\src-tauri\target\release\winku.exe",
  [int]$SettleSeconds = 20,
  [int]$BudgetMB = 150,
  [int]$CpuSampleSeconds = 20,
  [double]$CpuBudgetPercent = 1.0
)
$ErrorActionPreference = "Stop"

$env:WINKU_SMOKE = "1"
$env:WINKU_SMOKE_STAY = "1"
$out = Join-Path $env:RUNNER_TEMP "winku-smoke.out"
$app = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput $out
Start-Sleep -Seconds $SettleSeconds

function Get-Tree([int]$RootId) {
  $all = Get-CimInstance Win32_Process
  $ids = [System.Collections.Generic.List[int]]::new()
  $ids.Add($RootId)
  for ($i = 0; $i -lt $ids.Count; $i++) {
    $all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { $ids.Add([int]$_.ProcessId) }
  }
  $ids
}

$tree = Get-Tree $app.Id
$perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $tree -contains [int]$_.IDProcess }
$rows = $perf | ForEach-Object {
  $p = Get-Process -Id $_.IDProcess -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Name             = $_.Name
    Pid              = [int]$_.IDProcess
    PrivateWorkingMB = [math]::Round($_.WorkingSetPrivate / 1MB, 1)
    WorkingSetMB     = [math]::Round($p.WorkingSet64 / 1MB, 1)
    PrivateBytesMB   = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
  }
} | Sort-Object PrivateWorkingMB -Descending

$rows | Format-Table -AutoSize | Out-String | Write-Host
$total = ($rows | Measure-Object PrivateWorkingMB -Sum).Sum
$totalWs = ($rows | Measure-Object WorkingSetMB -Sum).Sum
Write-Host "Total private working set: $total MB (Task Manager's Memory column)"
Write-Host "Total working set:         $totalWs MB (includes shared pages)"
Write-Host "Budget:                    $BudgetMB MB"

# Idle CPU: total processor time used by the whole tree over the sample window, as a
# percentage of one core.
function Get-CpuSeconds([int[]]$Ids) {
  ($Ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } |
    ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
}
$tree = Get-Tree $app.Id
$cpuBefore = Get-CpuSeconds $tree
Start-Sleep -Seconds $CpuSampleSeconds
$cpuAfter = Get-CpuSeconds $tree
$cpuPercent = [math]::Round(100 * ($cpuAfter - $cpuBefore) / $CpuSampleSeconds, 2)
Write-Host "Idle CPU:                  $cpuPercent% of one core over $CpuSampleSeconds s (budget $CpuBudgetPercent%)"

Write-Host "--- smoke output"
Get-Content $out | Write-Host

if ($env:GITHUB_STEP_SUMMARY) {
  "### Idle memory on windows-latest`n" | Out-File $env:GITHUB_STEP_SUMMARY -Append
  "| Process | PID | Private working set (MB) | Working set (MB) | Private bytes (MB) |" | Out-File $env:GITHUB_STEP_SUMMARY -Append
  "|---|---|---|---|---|" | Out-File $env:GITHUB_STEP_SUMMARY -Append
  $rows | ForEach-Object { "| $($_.Name) | $($_.Pid) | $($_.PrivateWorkingMB) | $($_.WorkingSetMB) | $($_.PrivateBytesMB) |" } | Out-File $env:GITHUB_STEP_SUMMARY -Append
  "`n**Total private working set: $total MB** (budget $BudgetMB MB). Total working set: $totalWs MB." | Out-File $env:GITHUB_STEP_SUMMARY -Append
  "`n**Idle CPU: $cpuPercent% of one core** over $CpuSampleSeconds s (budget $CpuBudgetPercent%)." | Out-File $env:GITHUB_STEP_SUMMARY -Append
}

Get-Tree $app.Id | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }

if (-not (Select-String -Path $out -Pattern '"type":"reply_end"' -Quiet)) { throw "Smoke test: no reply_end from the engine" }
# Report against the budget without failing the job; the spike is about getting the number.
if ($total -gt $BudgetMB) { Write-Host "::warning::Idle memory $total MB is over the $BudgetMB MB budget" }
if ($cpuPercent -gt $CpuBudgetPercent) { Write-Host "::warning::Idle CPU $cpuPercent% is over the $CpuBudgetPercent% budget" }
