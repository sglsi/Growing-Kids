# Growing-Kids 数据库备份 · 计划任务注册脚本
# ------------------------------------------------------------------
# 为什么用 PowerShell 而不是 schtasks.exe：
#   本机 schtasks.exe 被环境策略拦截，pwsh/powershell 的 ScheduledTasks 模块可用。
#
# 注册两个任务：
#   GrowingKids-DB-Backup       每天 03:30  备份 + 上传网盘 + 读回自检
#   GrowingKids-DB-Drill        每周日 04:30 恢复演练（建空库跑迁移灌数据比对，结束自动擦除）
#
# 用法（在项目根目录 D:/AI/Growing-Kids 打开 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File server/scripts/register-backup-task.ps1
#   powershell -ExecutionPolicy Bypass -File server/scripts/register-backup-task.ps1 -Remove
#   powershell -ExecutionPolicy Bypass -File server/scripts/register-backup-task.ps1 -BackupTime 02:00
#
# ⚠️ 关键设计取舍：-LogonType Interactive = **只在用户登录时运行**。
#    原因是本机 node 与 python 环境都在用户目录下，S4U/Service 账户跑起来会找不到命令
#    （表现为任务"成功"退出但什么都没备份 —— 本项目最怕的静默失败）。
#    代价：机器关机或未登录的那天不会备份。可接受，因为保留 14 份、且每次上线都会补。
#    如需"关机也跑"，改 -LogonType S4U，但**必须**先用该账户手工试跑一次确认能连库。

param(
    [string]$BackupTime = '03:30',
    [string]$DrillTime = '04:30',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerDir = Split-Path -Parent $ScriptDir

# ⚠️ node 路径必须解析成**稳定安装位置**。
#    如果注册成 C:\Users\<你>\.workbuddy\binaries\node\...\node.exe，WorkBuddy 升级/清理时
#    这个 exe 会消失 ⇒ 计划任务每天"执行成功"但什么都没做（本项目最怕的静默失败）。
#    所以优先系统安装目录，找不到才退回 PATH。
$NodeCandidates = @(
    'D:\Program Files\nodejs\node.exe',
    'C:\Program Files\nodejs\node.exe'
)
$NodeExe = $null
foreach ($c in $NodeCandidates) {
    if (Test-Path $c) { $NodeExe = $c; break }
}
if (-not $NodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $NodeExe = $cmd.Source }
}
if (-not $NodeExe) { throw '找不到 node.exe，请先安装 Node.js（项目要求 >= 20）' }
if ($NodeExe -like '*\.workbuddy\*') {
    Write-Warning "node 落在 WorkBuddy 托管目录（$NodeExe），升级时可能被清理导致任务静默失效。建议改用系统安装的 Node。"
}

$BackupTask = 'GrowingKids-DB-Backup'
$DrillTask = 'GrowingKids-DB-Drill'

if ($Remove) {
    foreach ($t in @($BackupTask, $DrillTask)) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false
            Write-Host "[OK] 已删除计划任务 $t"
        } else {
            Write-Host "[--] 计划任务 $t 不存在，跳过"
        }
    }
    return
}

if (-not (Test-Path (Join-Path $ServerDir 'scripts\db-backup.mjs'))) {
    throw "找不到 $ServerDir\scripts\db-backup.mjs，请在项目仓库内运行本脚本"
}

function Register-GkTask {
    param(
        [string]$Name,
        [string]$ScriptRelPath,
        [string]$ScriptArgs,
        [string]$At,
        [string]$Weekday,
        [string]$Description
    )

    if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    }

    $action = New-ScheduledTaskAction -Execute $NodeExe `
        -Argument ('"{0}" {1}' -f (Join-Path $ServerDir $ScriptRelPath), $ScriptArgs) `
        -WorkingDirectory $ServerDir

    if ($Weekday) {
        $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Weekday -At $At
    } else {
        $trigger = New-ScheduledTaskTrigger -Daily -At $At
    }

    # 电池/空闲/超时：全部放宽。备份是低频小任务，不该因为"没插电源"被跳过
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
        -MultipleInstances IgnoreNew

    # -UserId 必须是 "域\用户" 形式；只用 $env:USERNAME 会报 "参数错误 (UserId)"
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Description $Description | Out-Null

    Write-Host "[OK] 已注册 $Name  →  $At $(if ($Weekday) { "每 $Weekday" } else { '每天' })"
}

Register-GkTask -Name $BackupTask -ScriptRelPath 'scripts\db-backup.mjs' -ScriptArgs '--quiet' `
    -At $BackupTime -Weekday '' `
    -Description 'Growing-Kids 数据库每日备份：导出→加密→本地→百度网盘→读回自检'

Register-GkTask -Name $DrillTask -ScriptRelPath 'scripts\db-restore.mjs' -ScriptArgs '--verify' `
    -At $DrillTime -Weekday 'Sunday' `
    -Description 'Growing-Kids 备份恢复演练：建空库跑迁移灌数据比对，结束自动擦除（没有演练的备份等于没有备份）'

Write-Host ''
Write-Host '---- 当前状态 ----'
Get-ScheduledTask -TaskName $BackupTask, $DrillTask | ForEach-Object {
    $info = Get-ScheduledTaskInfo -TaskName $_.TaskName
    Write-Host ("{0,-26} {1,-10} 下次 {2}" -f $_.TaskName, $_.State, $info.NextRunTime)
}
Write-Host ''
Write-Host '手工验证：'
Write-Host "  & '$NodeExe' '$ServerDir\scripts\db-backup.mjs'"
Write-Host "  & '$NodeExe' '$ServerDir\scripts\db-restore.mjs' --verify"
