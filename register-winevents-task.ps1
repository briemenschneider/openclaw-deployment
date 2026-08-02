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
       ordinary client hangups) it logs why, exits with a NON-ZERO code, and
       relies on this task's RestartCount to bring it back (see
       winevents-collector.ps1's exit-code contract, documented on
       Start-WinEventsCollector). That is correct behavior for the process,
       but restart supervision only fires while something is still watching
       - if the machine goes a long stretch without a fresh logon, a
       collector that exhausted its restart budget (or was killed outside
       Task Scheduler's control) stays dead until something triggers again.
       The morning brief cron fires at 07:15 Europe/Berlin and needs the
       collector alive; this trigger fires ten minutes earlier so a dead
       collector is restarted in time regardless of when it died. The
       machine's local timezone is already Europe/Berlin, so 07:05 local
       needs no conversion.

       This trigger is cheap to fire twice in a row (e.g. logon + 07:05
       landing close together) NOT because the collector script is
       idempotent about the port - it is not: winevents-collector.ps1 calls
       HttpListener.Start() with no port pre-check, so a second instance
       against a live one throws (caught, logged, and exits non-zero as of
       the fix below, rather than crashing with an unhandled exception, but
       it is still a failed launch, not a silent no-op). The actual
       protection against two collectors racing for port 18790 is this
       task's own MultipleInstances=IgnoreNew setting (set explicitly
       below) - Task Scheduler will not start a second instance while one
       is already running, full stop, regardless of how many triggers fire.

  The restart policy below is deliberately generous: the collector can exit
  non-zero on its own (see above), and the whole point of Task Scheduler
  supervision here is to make that self-healing rather than a silent,
  multi-hour outage. Do not "tidy" RestartCount back down to a small number
  like 3 - three attempts at a 1-minute interval only buys 3 minutes of
  retrying, which is nowhere near enough if the machine is having a rough
  networking day. See the -RestartCount comment below.
#>

$ErrorActionPreference = 'Stop'

$taskName = 'OpenClaw - winevents collector'
$script   = Join-Path $PSScriptRoot 'connectors\winevents\winevents-collector.ps1'
$launcher = Join-Path $PSScriptRoot 'connectors\winevents\invoke-collector.ps1'

if (-not (Test-Path $script)) { throw "collector not found at $script" }
if (-not (Test-Path $launcher)) { throw "launcher not found at $launcher" }

# Execute is the stable, never-version-pinned Windows PowerShell 5.1
# binary (a core OS component under System32 - it never moves and is never
# removed), NOT pwsh.exe directly. pwsh is installed as an MSIX package
# whose real binary lives in a version-numbered WindowsApps directory (e.g.
# ...\Microsoft.PowerShell_7.6.4.0_x64__.../pwsh.exe) that disappears on
# upgrade; baking that path into this task at registration time works
# until the next pwsh upgrade, then silently reproduces
# ERROR_FILE_NOT_FOUND with no error until someone notices the brief has no
# event data. invoke-collector.ps1 resolves pwsh.exe at RUN TIME instead,
# via the registry "App Paths" key the pwsh installer keeps current across
# upgrades, then execs the real collector and propagates its exit code.
# See invoke-collector.ps1's own header for the full rationale, and
# task-4-report.md for the empirical verification (both of why bare
# 'pwsh.exe' fails under Task Scheduler, and of this launcher working).
$stablePwsh51 = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $stablePwsh51)) { throw "Windows PowerShell not found at $stablePwsh51" }

$action = New-ScheduledTaskAction -Execute $stablePwsh51 `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -CollectorScript `"$script`""

# Trigger 1: at logon, 45s in - see .DESCRIPTION above for why 45s.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logonTrigger.Delay = 'PT45S'

# Trigger 2: daily at 07:05 local (= Europe/Berlin) - safety net so a
# collector that died hours ago is back up ten minutes before the 07:15
# morning brief cron, even if the machine was never logged out overnight.
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At '07:05'

# RestartCount is high (not the usual small default) because the collector
# can exit non-zero on its own after sustained transport failure (see
# winevents-collector.ps1 - 10 consecutive GetContext() failures) rather
# than hot-spin, and Task Scheduler has no "restart forever" setting. 1440
# restarts at a 1-minute RestartInterval covers a full 24-hour day of
# retrying - by which point the 07:05 daily trigger (or the next logon)
# fires anyway and gives it a fresh start. Do not lower this back to a
# small number (e.g. 3) - that would turn "collector had a bad two seconds"
# into "collector is dead until tomorrow's trigger," defeating the point of
# this task.
#
# MultipleInstances is set explicitly to IgnoreNew (New-ScheduledTaskSettingsSet's
# default happens to already be IgnoreNew, but leaving it implicit means a
# future edit to this script could flip it without anyone noticing the
# significance). This is the setting that actually prevents two collectors
# racing for port 18790 when the logon and 07:05 triggers land close
# together, or when a restart attempt overlaps a new trigger firing - do
# not change this without also reconsidering the port-collision handling in
# winevents-collector.ps1.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 1440 `
    -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $dailyTrigger) `
    -Settings $settings -Principal $principal `
    -Description 'Serves filtered Windows event digests on 127.0.0.1:18790 for the OpenClaw morning brief. Unelevated by design.' `
    -Force | Out-Null

Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
