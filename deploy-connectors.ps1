<#
.SYNOPSIS
  Deploy connector source into the openclaw container's connectors volume.

.DESCRIPTION
  Git is the source of truth; the container gets a copy. A named volume is used
  rather than a /mnt/c bind mount so node_modules lives on the WSL filesystem
  with correct uid-1000 ownership.

  docker cp does not guarantee uid-1000 ownership on the copied files - it
  preserves/creates them however the daemon's default happens to land, which
  is not necessarily "node" (1000:1000), the user the openclaw container runs
  as. The connectors-init compose service only chowns /opt/connectors once, at
  `docker compose up` time; it does not run again when this script deploys
  connector source afterwards. So this script chowns the deployed directory
  itself, after the copy and before npm install, and is safe to re-run.
#>

$ErrorActionPreference = 'Stop'

$connectors = @('gbrief-winevents')

foreach ($name in $connectors) {
    $src = Join-Path $PSScriptRoot "connectors\$name"
    if (-not (Test-Path $src)) { throw "connector source not found: $src" }

    Write-Host "deploying $name..." -NoNewline
    docker exec openclaw rm -rf "/opt/connectors/$name"
    docker cp "$src" "openclaw:/opt/connectors/$name"
    docker exec openclaw chown -R 1000:1000 "/opt/connectors/$name"
    docker exec openclaw npm install --prefix "/opt/connectors/$name" --omit=dev --silent
    Write-Host " done."
}

Write-Host "reloading MCP runtimes..."
docker exec openclaw openclaw mcp reload
