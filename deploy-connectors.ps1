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

  That chown runs with `docker exec -u 0`, and the -u 0 is load-bearing, not
  tidiness. A plain `docker exec` runs as the image's USER (node, uid 1000),
  and an unprivileged process cannot chown a file it does not own - so in
  exactly the scenario this chown exists for (files landing owned by root),
  the unprivileged form fails with "Operation not permitted", exits 1, and
  Invoke-Docker aborts the deploy. Verified live in this container:

    docker exec    openclaw chown -R 1000:1000 <root-owned path>  -> exit 1
    docker exec -u 0 openclaw chown -R 1000:1000 <root-owned path>  -> exit 0

  It only LOOKED like the unprivileged form worked because the source lives
  on /mnt/c, where drvfs reports uid 1000, so docker cp already lands the
  files 1000:1000 and the chown is a no-op on its own files. `-u 0` is
  allowed here despite security_opt no-new-privileges:true - that option
  restricts privilege ESCALATION by a running process, not the uid docker
  exec starts a new process with (confirmed by the exit-0 run above).

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
  idempotent (chown -R, npm install, mcp add-if-absent, mcp reload).
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

function Test-McpServerRegistered {
    <#
    .SYNOPSIS
      True when openclaw already has an MCP server of this name configured.
    .DESCRIPTION
      `openclaw mcp show <name>` exits 0 when the server exists in
      mcp.servers and 1 with "No MCP server named ..." when it does not, so
      it doubles as a presence test. Deliberately NOT routed through
      Invoke-Docker: a non-zero exit here is the "absent" answer, not a
      failure to report.
    #>
    param([Parameter(Mandatory)][string]$Name)
    # $ErrorActionPreference is relaxed for the duration of the call: under
    # 'Stop', Windows PowerShell 5.1 turns a native command's stderr output
    # into a terminating NativeCommandError - and "No MCP server named ..." on
    # stderr is the ANSWER here, not a failure.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & wsl -e docker exec openclaw openclaw mcp show $Name 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    }
    finally { $ErrorActionPreference = $previous }
}

$connectors = @('gbrief-winevents')

# MCP registration commands, keyed by connector name. Run inside the
# container by `sh -c` so that $WINEVENTS_TOKEN is expanded from the
# CONTAINER's environment (compose env_file -> .env) - the token never
# appears in this script, in a PowerShell variable, or on a Windows process
# command line.
#
# Why --env WINEVENTS_TOKEN is needed at all: openclaw does NOT hand its own
# environment to the stdio MCP servers it spawns. Measured 2026-08-02 with a
# throwaway probe server that encoded env-var PRESENCE (never values) into its
# tool name: registered without --env it probed as `token_ABSENT__url_ABSENT`
# while WINEVENTS_TOKEN was demonstrably in the openclaw process's own environ
# (/proc/1/environ); registered with --env it probed as `token_PRESENT`. HOME
# came through in both, so it is a curated child environment, not an empty one.
# A SecretRef ({"source":"env","id":...}, as gateway.auth.token uses) is
# rejected here - `mcp set` fails config validation because mcp.servers.*.env
# values must be strings. So the value is stored literally in openclaw.json
# and that copy has to be rotated with the others; see .env.example.
#
# NOTE: single quotes only inside these strings. Windows PowerShell 5.1
# mangles double quotes when passing an argument through to a native command
# (verified: `sh -c 'printf "[%s]" "a b"'` arrives as `[a]` under 5.1 and as
# `[a b]` under pwsh 7), and this script must work under either edition.
# WINEVENTS_TOKEN is hex, so the unquoted expansion below is safe.
$mcpRegistrations = @{
    'gbrief-winevents' =
        'openclaw mcp add gbrief-winevents' +
        ' --command node' +
        ' --arg /opt/connectors/gbrief-winevents/index.mjs' +
        ' --env WINEVENTS_URL=http://host.docker.internal:18791' +
        ' --env WINEVENTS_TOKEN=$WINEVENTS_TOKEN' +
        ' --include windows_events_digest' +
        ' --timeout 30'
}

foreach ($name in $connectors) {
    $src = Join-Path $PSScriptRoot "connectors\$name"
    if (-not (Test-Path $src)) { throw "connector source not found: $src" }

    $srcWsl = ConvertTo-WslPath -WindowsPath $src

    Write-Host "deploying $name..." -NoNewline
    Invoke-Docker exec openclaw rm -rf "/opt/connectors/$name"
    Invoke-Docker cp "$srcWsl" "openclaw:/opt/connectors/$name"
    # -u 0 is required, not cosmetic - see the .DESCRIPTION above.
    Invoke-Docker exec -u 0 openclaw chown -R 1000:1000 "/opt/connectors/$name"
    Invoke-Docker exec openclaw npm install --prefix "/opt/connectors/$name" --omit=dev --silent
    Write-Host " done."
}

# Registering the MCP server is part of "deployed", not a separate manual
# step. Before this block the registration lived only as a hand-run command in
# the plan, persisted only inside the openclaw-config Docker volume - so a
# fresh machine, or a lost config volume, produced a container with the
# connector files present and no tool registered, and nothing said so. The
# connectors volume was made reproducible on exactly that argument; the
# registration is no different.
#
# Add-if-absent, never overwrite: an existing registration may carry
# hand-tuned toolFilter/timeout values, and clobbering those on every deploy
# would be its own silent failure. `openclaw mcp add` also probes the server
# before saving, so a broken shim fails here rather than at 07:15.
foreach ($name in $connectors) {
    if (-not $mcpRegistrations.ContainsKey($name)) {
        throw "no MCP registration command defined for connector '$name'"
    }

    if (Test-McpServerRegistered -Name $name) {
        Write-Host "MCP server $name already registered - leaving it alone."
        continue
    }

    # Fail loudly rather than registering a server that would 401 forever
    # against a token-less environment.
    $tokenState = (& wsl -e docker exec openclaw sh -c 'printf %s ${WINEVENTS_TOKEN:+present}' | Out-String).Trim()
    if ($tokenState -ne 'present') {
        throw "WINEVENTS_TOKEN is not set in the openclaw container's environment - recreate the container so env_file reloads .env before registering $name"
    }

    Write-Host "registering MCP server $name..."
    Invoke-Docker exec openclaw sh -c $mcpRegistrations[$name]
}

Write-Host "reloading MCP runtimes..."
Invoke-Docker exec openclaw openclaw mcp reload
