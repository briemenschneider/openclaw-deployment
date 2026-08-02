<#
.SYNOPSIS
  Register the Windows event collector as a logon scheduled task.

.DESCRIPTION
  Mirrors the "Ollama - autostart at logon" task. Unelevated by design - the
  collector only needs Event Log Readers group membership to reach the Security
  channel, and an always-on elevated process feeding an LLM is a far larger
  blast radius than a read-only reporting job justifies.

  Two triggers are registered on the same task:

    1. At logon (45s delay) - starts the collector for the normal case of
       logging in fresh. The 45s delay is deliberately longer than the
       Ollama task's 30s: the collector is not on the critical path for
       07:15 and should not compete with model loading during the boot
       storm.

    2. Daily at 07:05 local time - a safety net. The collector is a
       long-running listener, and its own hardening (see
       winevents-collector.ps1) makes a deliberate choice: after 10
       consecutive GetContext() failures (sustained transport failure, not
       ordinary client hangups) it logs why and exits cleanly rather than
       hot-spinning forever. That is correct behavior for the process, but
       it means the collector can legitimately be dead while the user is
       still logged on, and a logon-only trigger would not bring it back
       until the next logon - which, on a machine that stays logged in for
       days, could be never. The morning brief cron fires at 07:15
       Europe/Berlin and needs the collector alive; this trigger fires ten
       minutes earlier so a dead collector is restarted in time regardless
       of when it died. The machine's local timezone is already Europe/
       Berlin, so 07:05 local needs no conversion. This trigger is cheap
       because the collector script itself is idempotent - if it is already
       listening on 18790, it logs "nothing to do" and exits 0.

  The restart policy below is deliberately generous for the same reason:
  the collector can give up and exit on its own, and the whole point of
  Task Scheduler supervision here is to make that self-healing rather than
  a silent, multi-hour outage. Do not "tidy" RestartCount back down to a
  small number like 3 - three attempts at a 1-minute interval only buys 3
  minutes of retrying, which is nowhere near enough if the machine is
  having a rough networking day. See the -RestartCount comment below.
#>

$ErrorActionPreference = 'Stop'

$taskName = 'OpenClaw - winevents collector'
$script   = Join-Path $PSScriptRoot 'connectors\winevents\winevents-collector.ps1'

if (-not (Test-Path $script)) { throw "collector not found at $script" }

# Resolve pwsh.exe to its real install directory via $PSHOME rather than the
# bare 'pwsh.exe' name. This machine's PATH resolution for 'pwsh.exe' only
# works interactively (extra WindowsApps package entries get injected into
# an interactive session's PATH that are not present in the persisted
# Machine/User PATH). Task Scheduler builds its process environment from the
# persisted PATH only, so a bare 'pwsh.exe' resolves to the 0-byte App
# Execution Alias stub in AppData\Local\Microsoft\WindowsApps, which is a
# reparse point requiring shell activation and fails with ERROR_FILE_NOT_FOUND
# (ends up as LastTaskResult -2147024894) when launched via CreateProcess as
# Task Scheduler does. $PSHOME points at the real pwsh.exe binary regardless
# of PATH, sidestepping the alias entirely.
$pwshExe = Join-Path $PSHOME 'pwsh.exe'
if (-not (Test-Path $pwshExe)) { throw "pwsh.exe not found at $pwshExe" }

$action = New-ScheduledTaskAction -Execute $pwshExe `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

# Trigger 1: at logon, 45s in - see .DESCRIPTION above for why 45s.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logonTrigger.Delay = 'PT45S'

# Trigger 2: daily at 07:05 local (= Europe/Berlin) - safety net so a
# collector that died hours ago is back up ten minutes before the 07:15
# morning brief cron, even if the machine was never logged out overnight.
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At '07:05'

# RestartCount is high (not the usual small default) because the collector
# can deliberately exit clean after sustained transport failure (see
# winevents-collector.ps1 - 10 consecutive GetContext() failures) rather
# than hot-spin, and Task Scheduler has no "restart forever" setting. 1440
# restarts at a 1-minute RestartInterval covers a full 24-hour day of
# retrying - by which point the 07:05 daily trigger (or the next logon)
# fires anyway and gives it a fresh start. Do not lower this back to a
# small number (e.g. 3) - that would turn "collector had a bad two seconds"
# into "collector is dead until tomorrow's trigger," defeating the point of
# this task.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 1440 -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $dailyTrigger) `
    -Settings $settings -Principal $principal `
    -Description 'Serves filtered Windows event digests on 127.0.0.1:18790 for the OpenClaw morning brief. Unelevated by design.' `
    -Force | Out-Null

Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
