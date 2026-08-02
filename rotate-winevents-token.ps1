<#
.SYNOPSIS
  Rotate WINEVENTS_TOKEN across every location that holds a copy, then prove
  the whole chain still answers.

.DESCRIPTION
  The token exists in THREE places. A rotation that updates fewer than three
  leaves the chain returning 401, and the only place that shows is inside an
  MCP tool result nobody reads:

    1. .env                                        -> the container, via
                                                      compose env_file
    2. %LOCALAPPDATA%\OpenClawBrief\winevents.token -> the collector, read ONCE
                                                      at startup
    3. mcp.servers.gbrief-winevents.env.WINEVENTS_TOKEN in openclaw.json
                                                   -> the MCP shim, CLEARTEXT,
                                                      inside the openclaw-config
                                                      volume

  The third copy is not redundant. openclaw does NOT pass its own environment
  to the stdio MCP servers it spawns - measured with a probe server that
  encoded env-var PRESENCE (never values) into its tool name: registered
  without --env it saw token_ABSENT while WINEVENTS_TOKEN was demonstrably in
  the openclaw process's own /proc/1/environ; registered with --env it saw
  token_PRESENT. A SecretRef ({"source":"env","id":...}, as gateway.auth.token
  uses) is rejected, because mcp.servers.*.env values must be strings. So the
  literal value has to be stored, and it has to be rotated with the rest.

  This script exists because the previous procedure was three prose steps in a
  plan document that only mentioned two of the three locations, and whose .env
  step used `Add-Content`, which APPENDS a second WINEVENTS_TOKEN= line on
  every re-run rather than replacing the first.

  Ordering is load-bearing:

    .env  ->  recreate the container (so env_file reloads)
          ->  re-register the MCP server (so it picks up the fresh container
              environment)
          ->  token file  ->  restart the collector (it reads the file once)

  The new token value is never printed. Verification compares SHA-256 digests
  rather than values.

.NOTES
  Requires: the openclaw stack up, Docker reachable through `wsl -e docker`,
  and the winevents scheduled task registered. Safe to re-run.
#>

$ErrorActionPreference = 'Stop'

$taskName    = 'OpenClaw - winevents collector'
$serverName  = 'gbrief-winevents'
$envFile     = Join-Path $PSScriptRoot '.env'
$tokenDir    = Join-Path $env:LOCALAPPDATA 'OpenClawBrief'
$tokenFile   = Join-Path $tokenDir 'winevents.token'
$composeFile = Join-Path $PSScriptRoot 'docker-compose.yml'

function Invoke-Docker {
    # Takes an explicit array rather than ValueFromRemainingArguments: the
    # argument lists here contain things like -f and -d, which PowerShell would
    # otherwise try to bind as parameter names of this function.
    param([Parameter(Mandatory)][string[]]$DockerArgs)
    & wsl -e docker @DockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($DockerArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function ConvertTo-WslPath {
    param([Parameter(Mandatory)][string]$WindowsPath)
    $p = & wsl -e wslpath -a "$WindowsPath" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "wslpath failed to translate '$WindowsPath': $p" }
    $p = ($p | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($p)) { throw "wslpath returned an empty path for '$WindowsPath'" }
    return $p
}

function Get-Sha256Hex {
    param([Parameter(Mandatory)][string]$Text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::ASCII.GetBytes($Text))
        return (($bytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
    }
    finally { $sha.Dispose() }
}

# ---------------------------------------------------------------- 1. generate
# A cryptographic RNG, not Get-Random. Get-Random is a seeded, non-cryptographic
# PRNG; it is the wrong tool for a shared secret even one that only guards
# loopback.
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$token = (($bytes | ForEach-Object { '{0:x2}' -f $_ }) -join '')
$tokenHash = Get-Sha256Hex -Text $token
Write-Host "generated a new token (sha256 $($tokenHash.Substring(0,12))...)"

# --------------------------------------------------------------- 2. .env copy
# Replace an existing WINEVENTS_TOKEN= line rather than appending one. The
# previous procedure used Add-Content, so a second rotation left TWO
# WINEVENTS_TOKEN= lines in .env and the winner was whichever the parser
# happened to take last.
#
# Both sides of this round-trip need to agree on encoding: .env contains
# non-ASCII characters in a comment.
#
# Read side: without -Encoding, Windows PowerShell 5.1's Get-Content decodes
# a BOM-less file using the ANSI code page, silently mangling those
# characters. -Encoding UTF8 reads BOM-less UTF-8 correctly on both Windows
# PowerShell 5.1 and pwsh 7.
#
# Write side: rewritten as UTF-8 WITHOUT a BOM via .NET rather than
# Set-Content, because Windows PowerShell 5.1's -Encoding utf8 emits a BOM,
# which docker compose would read as part of the first variable name.
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile - copy .env.example first" }
$lines = @(Get-Content -LiteralPath $envFile -Encoding UTF8)
if (@($lines | Where-Object { $_ -match '^\s*WINEVENTS_TOKEN=' }).Count -gt 0) {
    $lines = $lines | ForEach-Object {
        if ($_ -match '^\s*WINEVENTS_TOKEN=') { "WINEVENTS_TOKEN=$token" } else { $_ }
    }
} else {
    $lines += "WINEVENTS_TOKEN=$token"
}
[System.IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object System.Text.UTF8Encoding($false)))
$tokenLineCount = @(Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*WINEVENTS_TOKEN=' }).Count
if ($tokenLineCount -ne 1) { throw ".env now has $tokenLineCount WINEVENTS_TOKEN lines, expected exactly 1" }
Write-Host "updated .env (exactly one WINEVENTS_TOKEN line)"

# ------------------------------------------------- 3. container env_file copy
# --force-recreate because a container does not re-read env_file on restart,
# and --no-deps so this does not drag connectors-init along.
$composeWsl = ConvertTo-WslPath -WindowsPath $composeFile
$projectWsl = ConvertTo-WslPath -WindowsPath $PSScriptRoot
Write-Host "recreating the openclaw container so env_file reloads..."
Invoke-Docker -DockerArgs @(
    'compose', '-f', $composeWsl, '--project-directory', $projectWsl,
    'up', '-d', '--force-recreate', '--no-deps', 'openclaw'
)

# Prove the container actually has the new value, by digest not by value. This
# is the step that catches "compose did not reload .env", which would otherwise
# surface only as a 401 hours later.
$containerHash = (& wsl -e docker exec openclaw sh -c 'printf %s $WINEVENTS_TOKEN | sha256sum' | Out-String).Trim().Split(' ')[0]
if ($containerHash -ne $tokenHash) {
    throw "the openclaw container's WINEVENTS_TOKEN does not match the new token (digest mismatch) - env_file did not reload"
}
Write-Host "container environment carries the new token (digest match)"

# --------------------------------------------------- 4. openclaw.json copy
# Unset then re-add. deploy-connectors.ps1 is add-if-absent by design (it must
# not clobber a hand-tuned toolFilter on an ordinary deploy), so rotation has
# to remove the stale entry first. The re-add expands $WINEVENTS_TOKEN inside
# the container, from the environment verified above.
Write-Host "re-registering the MCP server with the new token..."
# Relaxed for the same reason as Test-McpServerRegistered in
# deploy-connectors.ps1: `mcp unset` on an already-absent server writes to
# stderr, which Windows PowerShell 5.1 turns into a terminating error under
# 'Stop'. An absent server is a fine starting state for a rotation.
$previous = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try { & wsl -e docker exec openclaw openclaw mcp unset $serverName 2>&1 | Out-Null }
finally { $ErrorActionPreference = $previous }
& (Join-Path $PSScriptRoot 'deploy-connectors.ps1')

# ------------------------------------------------------- 5. collector copy
New-Item -ItemType Directory -Force -Path $tokenDir | Out-Null

# The existing file is locked down, so restore the owner's write access before
# trying to overwrite it. The original one-shot procedure granted the owner
# READ ONLY - which is not what 0600 means, and which makes the file
# unrotatable: Set-Content fails with UnauthorizedAccessException. Nobody
# noticed because the procedure was only ever run once. Grant (M) instead:
# 0600 is owner read+write, and the point of the ACL is to exclude everyone
# else, not to lock the owner out of their own secret.
if (Test-Path -LiteralPath $tokenFile) {
    & icacls $tokenFile /grant "$($env:USERNAME):(M)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed to restore write access to $tokenFile (exit $LASTEXITCODE)" }
}

Set-Content -LiteralPath $tokenFile -Value $token -NoNewline -Encoding ascii

# Strip inherited ACEs and leave the owning user as the only principal on the
# file - the Windows equivalent of chmod 0600.
& icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(M)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed to restrict $tokenFile (exit $LASTEXITCODE)" }
Write-Host "updated the collector token file"

# The collector reads the token file ONCE at startup, so it must be restarted
# or it keeps authenticating against the old value.
Write-Host "restarting the collector task..."
Stop-ScheduledTask -TaskName $taskName

# Stop-ScheduledTask returns as soon as the stop has been REQUESTED, not when
# the process has gone. Starting again immediately races the old instance's
# grip on port 18790: HttpListener.Start() fails with "conflicts with an
# existing registration on the machine", the new instance exits 1, and the task
# settles into State=Ready with nothing listening - a dead collector that looks
# like a clean stop. Wait for the task to actually leave Running AND for the
# port to fall silent before starting again.
$stopDeadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $stopDeadline) {
    $stillRunning = (Get-ScheduledTask -TaskName $taskName).State -eq 'Running'
    $portHeld = @(Get-NetTCPConnection -LocalPort 18790 -State Listen -ErrorAction SilentlyContinue).Count -gt 0
    if (-not $stillRunning -and -not $portHeld) { break }
    Start-Sleep -Milliseconds 500
}
if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') {
    throw "the collector task was still Running 30s after Stop-ScheduledTask - refusing to start a second instance"
}
if (@(Get-NetTCPConnection -LocalPort 18790 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) {
    throw "something is still listening on 127.0.0.1:18790 after the collector task stopped - a second instance would fail to bind"
}

Start-ScheduledTask -TaskName $taskName

# ------------------------------------------------------------- 6. verify
$deadline = (Get-Date).AddSeconds(30)
$status = $null
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:18790/health' -Headers @{ 'X-Brief-Token' = $token } -UseBasicParsing -TimeoutSec 5
        $status = $r.StatusCode
        break
    }
    catch { Start-Sleep -Milliseconds 500 }
}
if ($status -ne 200) { throw "collector did not answer 200 on 127.0.0.1:18790/health after the rotation (got '$status')" }
Write-Host "collector /health on 127.0.0.1:18790 -> 200"

# Same request from inside the container, through winevents-fwd. No space after
# the colon in the -H value: Windows PowerShell 5.1 mangles embedded double
# quotes when passing an argument to a native command, so the shell string must
# not need any.
$containerStatus = (& wsl -e docker exec openclaw sh -c 'curl -sS -o /dev/null -m 20 -w %{http_code} -H X-Brief-Token:$WINEVENTS_TOKEN http://host.docker.internal:18791/health' | Out-String).Trim()
if ($containerStatus -ne '200') { throw "container -> forwarder -> collector returned '$containerStatus', expected 200" }
Write-Host "container /health through winevents-fwd:18791 -> 200"

Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
Write-Host "rotation complete. The new value was never printed."
