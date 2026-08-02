<#
.SYNOPSIS
  Deploy connector source into the openclaw container's connectors volume.

.DESCRIPTION
  Git is the source of truth; the container gets a copy. A named volume is used
  rather than a /mnt/c bind mount so node_modules lives on the WSL filesystem
  with correct uid-1000 ownership.

  There is no docker.exe on Windows in this environment. Docker Engine runs
  inside WSL2, and the only working client is `wsl -e docker`. Every docker
  invocation below goes through that.

  `docker cp`'s source path is read by the docker CLI process itself, which
  runs inside WSL - a Windows path like C:\Users\...\connectors\gbrief-winevents
  means nothing to it. It has to be translated to a WSL path (/mnt/c/Users/...)
  with `wsl -e wslpath -a` first, and the translated path is what gets passed
  to `docker cp`.

  docker cp also does not guarantee uid-1000 ownership on the copied files -
  it preserves/creates them however the daemon's default happens to land,
  which is not necessarily "node" (1000:1000), the user the openclaw
  container runs as. The connectors-init compose service only chowns
  /opt/connectors once, at `docker compose up` time; it does not run again
  when this script deploys connector source afterwards. So this script
  chowns the deployed directory itself, after the copy and before
  npm install.

  $ErrorActionPreference = 'Stop' does NOT make a non-zero exit from wsl.exe
  (a native command) a terminating error on its own - PowerShell only
  auto-throws on .NET/cmdlet errors, not on $LASTEXITCODE. Every docker
  invocation here therefore goes through Invoke-Docker, which checks
  $LASTEXITCODE explicitly and throws with the failing command and its exit
  code. This is what makes each step fail loudly instead of printing "done."
  over a broken deploy:
    - openclaw container not running/found  -> docker exec exits non-zero -> throws
    - connector source directory missing    -> Test-Path check throws before any docker call
    - npm install fails inside the container -> docker exec exits non-zero -> throws

  Re-running this script against an already-deployed connector is safe: each
  step either replaces its target outright (rm -rf then cp) or is naturally
  idempotent (chown -R, npm install, mcp reload).
#>

$ErrorActionPreference = 'Stop'

function Invoke-Docker {
    param(
        [Parameter(Mandatory, ValueFromRemainingArguments)]
        [string[]]$DockerArgs
    )
    & wsl -e docker @DockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($DockerArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function ConvertTo-WslPath {
    param([Parameter(Mandatory)][string]$WindowsPath)
    $wslPath = & wsl -e wslpath -a "$WindowsPath" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "wslpath failed to translate '$WindowsPath': $wslPath"
    }
    $wslPath = ($wslPath | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($wslPath)) {
        throw "wslpath returned an empty path for '$WindowsPath'"
    }
    return $wslPath
}

$connectors = @('gbrief-winevents')

foreach ($name in $connectors) {
    $src = Join-Path $PSScriptRoot "connectors\$name"
    if (-not (Test-Path $src)) { throw "connector source not found: $src" }

    $srcWsl = ConvertTo-WslPath -WindowsPath $src

    Write-Host "deploying $name..." -NoNewline
    Invoke-Docker exec openclaw rm -rf "/opt/connectors/$name"
    Invoke-Docker cp "$srcWsl" "openclaw:/opt/connectors/$name"
    Invoke-Docker exec openclaw chown -R 1000:1000 "/opt/connectors/$name"
    Invoke-Docker exec openclaw npm install --prefix "/opt/connectors/$name" --omit=dev --silent
    Write-Host " done."
}

Write-Host "reloading MCP runtimes..."
Invoke-Docker exec openclaw openclaw mcp reload
