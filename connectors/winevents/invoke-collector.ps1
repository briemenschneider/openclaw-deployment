<#
.SYNOPSIS
  Stable launcher for the winevents collector, run by
  C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe (see
  register-winevents-task.ps1) so the scheduled task's registered Execute
  path never changes across pwsh upgrades.

.DESCRIPTION
  The collector itself must run under pwsh (PowerShell 7+), not the
  Windows PowerShell 5.1 that hosts this launcher. pwsh is installed here
  as an MSIX package, so its real binary lives in a version-numbered
  directory under C:\Program Files\WindowsApps (e.g.
  ...\Microsoft.PowerShell_7.6.4.0_x64__.../pwsh.exe) that disappears on
  upgrade. Baking that path into the scheduled task at registration time
  (as an earlier version of register-winevents-task.ps1 did, via $PSHOME)
  works until the next pwsh upgrade, then silently reproduces
  ERROR_FILE_NOT_FOUND with no error until someone notices the brief has no
  event data.

  This script resolves pwsh.exe at RUN TIME instead, via the "App Paths"
  registry key that the pwsh MSIX installer maintains and updates on every
  install/upgrade (HKCU/HKLM ...\CurrentVersion\App Paths\pwsh.exe). This
  is the same mechanism Windows Explorer and Get-Command consult, so it
  reflects whatever pwsh version is actually installed, not whatever was
  installed on the day this task was registered.

  Why not just register 'pwsh.exe' directly as the Execute path and let
  PATH resolve it (the original brief's approach)? Because Task Scheduler
  builds its child process environment from the persisted Machine/User
  PATH, which does not contain the versioned WindowsApps directory - bare
  'pwsh.exe' resolves to the 0-byte App Execution Alias stub in
  AppData\Local\Microsoft\WindowsApps, a reparse point that requires shell
  activation and fails with ERROR_FILE_NOT_FOUND when launched via
  CreateProcess (which is what Task Scheduler uses). See task-4-report.md
  for the empirical verification of both failure modes and of this fix.

  powershell.exe (v1.0, System32) is the launcher because it is a core
  Windows component that is never removed, never version-bumped in a way
  that changes its path, and does not itself depend on any App Execution
  Alias to be invoked - registering it directly as Execute sidesteps the
  whole class of problem this script exists to solve.

  Exit code: this script propagates the collector's own exit code
  ($LASTEXITCODE from the child pwsh process) so Task Scheduler's
  RestartCount supervision (see register-winevents-task.ps1) sees the
  collector's real success/failure, not just "the launcher ran". If pwsh
  itself cannot be resolved, this script exits 9009 (a value chosen to be
  obviously not one of the collector's own exit codes) so a stuck
  App Paths registry entry is distinguishable in Task Scheduler history
  from an ordinary collector failure.
#>

param(
    [string]$CollectorScript = (Join-Path $PSScriptRoot 'winevents-collector.ps1')
)

$ErrorActionPreference = 'Stop'

function Resolve-PwshPath {
    foreach ($hive in 'HKCU', 'HKLM') {
        $keyPath = "${hive}:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\pwsh.exe"
        $prop = Get-ItemProperty -Path $keyPath -ErrorAction SilentlyContinue
        if ($prop -and $prop.'(default)' -and (Test-Path $prop.'(default)')) {
            return $prop.'(default)'
        }
    }
    return $null
}

$pwshPath = Resolve-PwshPath
if (-not $pwshPath) {
    # Write-Error is a terminating error under $ErrorActionPreference =
    # 'Stop' and would abort the script before the explicit exit code
    # below runs - use the error stream directly instead so the intended
    # exit code (9009, distinguishable from the collector's own 0/1 codes
    # in Task Scheduler history) actually takes effect.
    [Console]::Error.WriteLine("could not resolve pwsh.exe via the App Paths registry key (HKCU/HKLM ...\App Paths\pwsh.exe) - is PowerShell 7 installed?")
    exit 9009
}

if (-not (Test-Path $CollectorScript)) {
    [Console]::Error.WriteLine("collector script not found at $CollectorScript")
    exit 9009
}

& $pwshPath -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $CollectorScript
exit $LASTEXITCODE
