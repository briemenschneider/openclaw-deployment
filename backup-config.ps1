<#
.SYNOPSIS
  Back up the OpenClaw config volume to a timestamped tarball.

.DESCRIPTION
  Config lives in the `openclaw_openclaw-config` named volume inside WSL's Docker
  data root, not on the Windows filesystem. It survives container stop/start/rm,
  but is destroyed by `docker compose down -v`, `docker volume rm`, or
  `wsl --unregister`.

  Writes to .\backups\ (gitignored - the archive contains the gateway auth token
  and any other secrets in openclaw.json).
#>

$ErrorActionPreference = 'Stop'

$BackupDir = Join-Path $PSScriptRoot 'backups'
$Volume    = 'openclaw_openclaw-config'
$Stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$Name      = "openclaw-config-$Stamp.tar.gz"

if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir | Out-Null }

Write-Host "Backing up $Volume..." -NoNewline

# Stream the tarball to stdout and capture it on the Windows side, so no
# intermediate file is left inside WSL.
$wslPath = ($BackupDir -replace '\\','/' -replace '^([A-Za-z]):','/mnt/$1').ToLower()

wsl -e docker run --rm -v "${Volume}:/data:ro" -v "${wslPath}:/backup" alpine `
    tar czf "/backup/$Name" -C /data .

$out = Join-Path $BackupDir $Name
if (Test-Path $out) {
    $size = [math]::Round((Get-Item $out).Length / 1KB, 1)
    Write-Host " done. $Name ($size KB)" -ForegroundColor Green
} else {
    throw "Backup failed - $out not created"
}

Write-Host ""
Write-Host "Restore with:" -ForegroundColor Cyan
Write-Host "  docker run --rm -v ${Volume}:/data -v <dir>:/backup alpine tar xzf /backup/$Name -C /data"
