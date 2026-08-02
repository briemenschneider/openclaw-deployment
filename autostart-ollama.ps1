<#
.SYNOPSIS
  Start Ollama's API server at logon. Registered as the scheduled task
  "Ollama - autostart at logon" (see register-ollama-autostart.ps1).

.DESCRIPTION
  Why this exists: Docker/WSL and the OpenClaw stack come up automatically at
  boot (restart: unless-stopped), but Ollama did not - the tray app fails to
  spawn its `serve` backend, so nothing started it until start.ps1 was run by
  hand. The "Morning brief" cron fires at 07:15 Europe/Berlin, minutes after a
  cold boot, and was hitting a dead Ollama every single time.

  The failure was invisible: ollama-fwd accepts the connection and only then
  dials upstream, so a down Ollama presented as a 240s "model idle timeout"
  with zero tokens rather than a connection error. See docker-compose.yml.

  This is the Ollama half of start.ps1, made unattended: no console output on
  the happy path, appends to a log so a 07:15 failure is diagnosable after the
  fact. start.ps1 remains the manual full-stack entry point and is unaffected -
  it already no-ops when Ollama is listening.
#>

$ErrorActionPreference = 'Stop'

$OllamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
$Port      = 11434
$LogFile   = "$env:LOCALAPPDATA\Ollama\autostart.log"

function Write-Log {
    param([string]$Message)
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

function Test-OllamaUp {
    $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

New-Item -ItemType Directory -Path (Split-Path $LogFile) -Force | Out-Null

try {
    if (Test-OllamaUp) {
        Write-Log "already listening on $Port - nothing to do"
        return
    }

    if (-not (Test-Path $OllamaExe)) { throw "ollama.exe not found at $OllamaExe" }

    # Loopback-only bind, set explicitly rather than inherited - same rationale
    # as start.ps1. Ollama is reached from the container via the ollama-fwd
    # socat forwarder, so it never needs a routable interface.
    $env:OLLAMA_HOST = "127.0.0.1:$Port"

    Start-Process -FilePath $OllamaExe -ArgumentList 'serve' -WindowStyle Hidden

    # Wait on the listener, not a fixed sleep. 60s (vs start.ps1's 30s) because
    # a logon-time start competes with the rest of the boot storm.
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline -and -not (Test-OllamaUp)) {
        Start-Sleep -Milliseconds 500
    }

    if (Test-OllamaUp) {
        Write-Log "started, listening on 127.0.0.1:$Port"
    }
    else {
        Write-Log "FAILED - no listener on $Port after 60s. Check $env:LOCALAPPDATA\Ollama\server.log"
        exit 1
    }
}
catch {
    Write-Log "ERROR - $($_.Exception.Message)"
    exit 1
}
