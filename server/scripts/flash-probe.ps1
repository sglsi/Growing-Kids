# Flash-process probe: catch short-lived windows/processes that pop up and vanish.
# Usage: powershell -File server/scripts/flash-probe.ps1 [-Seconds 300]
# Output: server/logs/flash-probe.log  (new process + parent + cmdline; lifetime on exit)
# NOTE: ASCII only! Windows PowerShell 5.1 reads this file with the local ANSI
# codepage; any UTF-8 Chinese byte sequence scrambles the script structure.
param([int]$Seconds = 300)

$log = Join-Path $PSScriptRoot '..\logs\flash-probe.log'
$dir = Split-Path $log -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$line = "===== probe start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') duration=${Seconds}s ====="
Add-Content -Path $log -Value $line

$known = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($p in Get-Process) { [void]$known.Add([int]$p.Id) }

$firstSeen = @{}
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
    $alive = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($p in Get-Process) {
        [void]$alive.Add([int]$p.Id)
        $id = [int]$p.Id
        if (-not $known.Contains($id) -and -not $firstSeen.ContainsKey($id)) {
            $rec = @{ Time = Get-Date; Name = $p.ProcessName; Cmd = ''; Parent = '' }
            $c = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
            if ($c) {
                $rec.Cmd = ($c.CommandLine -replace "`r|`n", ' ')
                $pp = Get-Process -Id ([int]$c.ParentProcessId) -ErrorAction SilentlyContinue
                if ($pp) { $rec.Parent = "$($pp.ProcessName)($($c.ParentProcessId))" }
                else { $rec.Parent = "?($($c.ParentProcessId))" }
            }
            $firstSeen[$id] = $rec
            $txt = "[{0}] NEW  {1} pid={2} parent={3} cmd={4}" -f `
                (Get-Date -Format 'HH:mm:ss.fff'), $rec.Name, $id, $rec.Parent, $rec.Cmd
            Add-Content -Path $log -Value $txt
        }
    }
    $gone = @()
    foreach ($k in $firstSeen.Keys) { if (-not $alive.Contains([int]$k)) { $gone += $k } }
    foreach ($k in $gone) {
        $r = $firstSeen[$k]
        $life = [int]((Get-Date) - $r.Time).TotalMilliseconds
        $txt = "[{0}] GONE {1} pid={2} life={3}ms parent={4} cmd={5}" -f `
            (Get-Date -Format 'HH:mm:ss.fff'), $r.Name, $k, $life, $r.Parent, $r.Cmd
        Add-Content -Path $log -Value $txt
        $firstSeen.Remove($k)
        [void]$known.Add([int]$k)
    }
    Start-Sleep -Milliseconds 200
}
Add-Content -Path $log -Value "===== probe end $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
