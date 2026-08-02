<#
.SYNOPSIS
  Start Ollama's API server (if not already listening) and bring up the OpenClaw stack.

.DESCRIPTION
  The Ollama tray app on this machine fails to spawn its `serve` backend - it logs
  "timeout waiting for Ollama server to be ready" and never writes server.log.
  Running `ollama serve` directly works fine, so this script does that itself.

  Ollama stays bound to 127.0.0.1. The container reaches it through the ollama-fwd
  socat container, which sits in WSL's network namespace and re-publishes Ollama on
  the docker0 gateway - see README.
#>

$ErrorActionPreference = 'Stop'

$OllamaExe = "C:\Users\briem\AppData\Local\Programs\Ollama\ollama.exe"
$Port      = 11434

function Test-OllamaUp {
    $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

if (Test-OllamaUp) {
    Write-Host "Ollama already listening on $Port." -ForegroundColor Green
}
else {
    if (-not (Test-Path $OllamaExe)) { throw "ollama.exe not found at $OllamaExe" }

    # Loopback-only bind. The container reaches Ollama through the ollama-fwd
    # socat container, which lives in WSL's network namespace and can therefore
    # use 127.0.0.1 - so Ollama never needs to listen on a routable interface.
    # Set explicitly rather than inheriting: a shell that predates any OLLAMA_HOST
    # change would otherwise silently pick a different bind.
    $env:OLLAMA_HOST = "127.0.0.1:$Port"

    Write-Host "Starting ollama serve..." -NoNewline
    Start-Process -FilePath $OllamaExe -ArgumentList 'serve' -WindowStyle Hidden

    # Wait for the listener rather than sleeping a fixed interval.
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-OllamaUp)) {
        Start-Sleep -Milliseconds 500
        Write-Host "." -NoNewline
    }

    if (Test-OllamaUp) {
        Write-Host " up." -ForegroundColor Green
    }
    else {
        Write-Host ""
        throw "Ollama did not start within 30s. Check %LOCALAPPDATA%\Ollama\server.log"
    }
}

Write-Host "Bringing up OpenClaw..."
docker compose --project-directory $PSScriptRoot up -d

Write-Host ""
Write-Host "Gateway:  http://127.0.0.1:18789" -ForegroundColor Cyan
Write-Host "Ollama:   http://127.0.0.1:$Port" -ForegroundColor Cyan
