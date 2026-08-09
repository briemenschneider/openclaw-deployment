<#
.SYNOPSIS
  Build, pack, and install the Agent Studio plugin into the openclaw container.

.DESCRIPTION
  Git is the source of truth; the container gets an installed npm pack. The
  plugin is installed from a tarball rather than from raw TypeScript sources so
  what runs in the container is exactly what `npm pack` produced - dist/, the
  manifest, README, and LICENSE, and nothing else.

  There is no docker.exe on Windows in this environment. Docker Engine runs
  inside WSL2 and the only working client is `wsl -e docker`, so every docker
  invocation below goes through that. `docker cp`'s source path is read by the
  docker CLI process running inside WSL, so a Windows path has to be translated
  with `wsl -e wslpath -a` first - same rule as deploy-connectors.ps1.

  $ErrorActionPreference = 'Stop' does NOT make a non-zero exit from a native
  command a terminating error, so every docker call goes through Invoke-Docker
  and every npm call through Invoke-Npm; both check $LASTEXITCODE explicitly
  and throw. A broken build, a failing test, or a refused install therefore
  stops the deploy instead of printing "done." over it.

  Secrets: this script never reads .env, never passes the Gateway token, and
  never echoes container environment. The panel asks the operator for the token
  in the browser at connect time; nothing here needs it.

  Re-running is safe. `plugins install --force` replaces the installed copy,
  `plugins enable` is idempotent, and the staged tarball is removed from the
  container afterwards.

.PARAMETER SkipTests
  Skip typecheck and the test suite. Only for iterating on the deploy steps
  themselves - never for a release.

.PARAMETER SkipRestart
  Install without restarting the Gateway. The plugin will not be active until
  the container restarts.
#>

[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$SkipRestart
)

$ErrorActionPreference = 'Stop'

$pluginId = 'agent-studio'
$pluginRoot = Join-Path $PSScriptRoot 'plugins\agent-studio'

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

function Invoke-Npm {
    param(
        [Parameter(Mandatory, ValueFromRemainingArguments)]
        [string[]]$NpmArgs
    )
    & npm --prefix "$pluginRoot" @NpmArgs
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($NpmArgs -join ' ') failed with exit code $LASTEXITCODE"
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

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is not on PATH. Node 24 is required to build the plugin; if you use nvm4w, run 'nvm use 24' first."
}
if (-not (Test-Path $pluginRoot)) { throw "plugin source not found: $pluginRoot" }

Write-Host 'installing plugin dependencies...'
Invoke-Npm install --no-audit --no-fund

if (-not $SkipTests) {
    Write-Host 'typechecking...'
    Invoke-Npm run typecheck
    Write-Host 'running tests...'
    Invoke-Npm test
}

Write-Host 'building runtime and panel bundles...'
Invoke-Npm run build

# Inspect the build output before it is packed. Source maps would ship the
# original TypeScript into the container, and a literal token string in a
# bundle would mean a test credential leaked into the release.
$distRoot = Join-Path $pluginRoot 'dist'
$sourceMaps = Get-ChildItem -Path $distRoot -Recurse -Filter '*.map' -ErrorAction SilentlyContinue
if ($sourceMaps) {
    throw "dist contains source maps: $($sourceMaps.FullName -join ', ')"
}
$suspicious = Get-ChildItem -Path $distRoot -Recurse -File |
    Select-String -Pattern 'sk-[A-Za-z0-9]{16,}', 'OPENCLAW_GATEWAY_TOKEN\s*=', 'browser-only-token' -List
if ($suspicious) {
    throw "dist contains what looks like a credential: $($suspicious.Path -join ', ')"
}

Write-Host 'checking the package contents...'
$dryRun = & npm --prefix "$pluginRoot" pack --dry-run --json 2>&1
if ($LASTEXITCODE -ne 0) { throw "npm pack --dry-run failed with exit code $LASTEXITCODE" }
$packed = ($dryRun | Out-String | ConvertFrom-Json)[0]
$files = $packed.files.path
foreach ($required in @('openclaw.plugin.json', 'dist/index.js', 'dist/ui/index.html')) {
    if ($files -notcontains $required) {
        throw "packaged files are missing $required (got: $($files -join ', '))"
    }
}
if (-not ($files | Where-Object { $_ -like 'dist/ui/assets/*.js' })) {
    throw 'packaged files contain no panel bundle under dist/ui/assets'
}
if ($files | Where-Object { $_ -like 'src/*' -or $_ -like 'test/*' }) {
    throw 'packaged files unexpectedly include sources or tests'
}

Write-Host 'packing...'
Push-Location $pluginRoot
try {
    $tarballName = (& npm pack --silent 2>&1 | Out-String).Trim() -split "`n" | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { throw "npm pack failed with exit code $LASTEXITCODE" }
}
finally { Pop-Location }

$tarball = Join-Path $pluginRoot $tarballName
if (-not (Test-Path $tarball)) { throw "npm pack did not produce $tarball" }
$integrity = (Get-FileHash -Path $tarball -Algorithm SHA256).Hash.ToLower()
Write-Host "packed $tarballName (sha256:$integrity)"

$tarballWsl = ConvertTo-WslPath -WindowsPath $tarball
$containerTarball = "/tmp/$tarballName"

Write-Host 'staging the tarball in the container...'
Invoke-Docker cp "$tarballWsl" "openclaw:$containerTarball"

try {
    Write-Host 'installing the plugin...'
    Invoke-Docker exec openclaw openclaw plugins install "npm-pack:$containerTarball" --force
    Write-Host 'enabling the plugin...'
    Invoke-Docker exec openclaw openclaw plugins enable $pluginId
}
finally {
    # Never leave the tarball behind in the container's /tmp.
    & wsl -e docker exec openclaw rm -f $containerTarball 2>&1 | Out-Null
}

if (-not $SkipRestart) {
    Write-Host 'restarting the Gateway...'
    Invoke-Docker restart openclaw
    Write-Host 'waiting for the Gateway to come back...'
    $deadline = (Get-Date).AddSeconds(90)
    do {
        Start-Sleep -Seconds 3
        & wsl -e docker exec openclaw openclaw plugins list 2>&1 | Out-Null
        $ready = ($LASTEXITCODE -eq 0)
    } while (-not $ready -and (Get-Date) -lt $deadline)
    if (-not $ready) { throw 'the Gateway did not become ready within 90 seconds' }
}

Write-Host 'runtime state:'
Invoke-Docker exec openclaw openclaw plugins inspect $pluginId --runtime --json

Write-Host ''
Write-Host "Agent Studio deployed. Open the dashboard and select the Agent Studio tab."
Write-Host "Record this build in docs/agent-studio.md: sha256:$integrity"
