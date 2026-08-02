# Windows Events Bridge Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose filtered Windows event data to OpenClaw as an MCP tool, so the 07:15 morning brief can report system and network anomalies.

**Architecture:** A PowerShell 7 collector on Windows queries the event log, applies deterministic filtering, and serves JSON over `http://127.0.0.1:18790`. A socat forwarder republishes that on the docker0 gateway. A small Node MCP stdio server inside the OpenClaw container wraps it as the `windows_events_digest` tool. All filtering logic lives in a PowerShell module with pure functions so it is unit-testable without touching a real event log.

**Tech Stack:** PowerShell 7.6.4, Pester 5, `System.Net.HttpListener`, Node 24 ESM, `@modelcontextprotocol/sdk`, alpine/socat.

**Spec:** `docs/superpowers/specs/2026-08-02-morning-brief-connectors-design.md`

## Global Constraints

- **ASCII only in `.ps1` / `.psm1` files.** PowerShell 5.1 reads script files as ANSI; em-dashes and smart quotes cause "missing terminator" parse errors. This repo's convention, applied even though the collector targets pwsh 7.
- **Never commit secrets.** `.env` is gitignored. `WINEVENTS_TOKEN` goes in `.env` and a `0600` file, never in a tracked file.
- **Every socat upstream gets `connect-timeout=5`.** A hanging upstream previously masked a dead backend as a 240s model idle timeout. See the comment block in `docker-compose.yml`.
- **Bind to `127.0.0.1` only.** Never `0.0.0.0`. Under WSL2 mirrored networking a wildcard bind is LAN-exposed.
- **The collector runs unelevated.** Security-log access comes from Event Log Readers group membership, never from elevation.
- **Pester 5 syntax** (`Should -Be`, not Pester 3's `Should Be`).
- Port: **18790** (verified free). Gateway is 18789 — do not collide.
- Container paths: connectors live at `/opt/connectors/<name>/` on the `openclaw-connectors` named volume.

---

## File Structure

| File | Responsibility |
|---|---|
| `connectors/winevents/WinEventsCore.psm1` | Pure filtering + digest assembly. No I/O in the filtering path. |
| `connectors/winevents/WinEventsCore.Tests.ps1` | Pester 5 tests for the module. |
| `connectors/winevents/winevents-allowlist.json` | Tunable noise suppression list. |
| `connectors/winevents/winevents-collector.ps1` | HTTP listener; imports the module. No filtering logic. |
| `connectors/gbrief-winevents/index.mjs` | Node MCP stdio server. Transport only. |
| `connectors/gbrief-winevents/index.test.mjs` | Tests against a stub HTTP server. |
| `connectors/gbrief-winevents/package.json` | Deps + test script. |
| `register-winevents-task.ps1` | Registers the logon scheduled task. |
| `deploy-connectors.ps1` | Copies connectors into the container volume, runs npm install. |
| `docker-compose.yml` | Add `winevents-fwd` service + `openclaw-connectors` volume. |

The split between `WinEventsCore.psm1` and `winevents-collector.ps1` is the load-bearing decomposition: filtering must be testable against synthetic events, which is impossible if it lives inside a request handler.

---

### Task 1: Event filtering core

**Files:**
- Create: `connectors/winevents/WinEventsCore.psm1`
- Create: `connectors/winevents/WinEventsCore.Tests.ps1`

**Interfaces:**
- Produces: `Select-BriefEvent -Events <object[]> -Now <datetime> -WindowHours <int> -Allowlist <object[]>` returns an array of digest objects with properties `channel, provider, id, level, firstSeen, lastSeen, occurrences, message`.
- Normalized input event shape (used by tests and by Task 2): `[pscustomobject]@{ Channel; ProviderName; Id; Level; TimeCreated; Message }` where `Level` is an int (1=Critical, 2=Error, 3=Warning, 4=Information).

- [ ] **Step 1: Install Pester 5**

The bundled Pester is 3.4.0 and its syntax is incompatible. User scope, no admin needed.

```powershell
Install-Module Pester -MinimumVersion 5.5.0 -Scope CurrentUser -Force -SkipPublisherCheck
Import-Module Pester -MinimumVersion 5.5.0 -Force
(Get-Module Pester).Version
```

Expected: `5.x.x`

- [ ] **Step 2: Write the failing tests**

Create `connectors/winevents/WinEventsCore.Tests.ps1`:

```powershell
BeforeAll {
    Import-Module "$PSScriptRoot\WinEventsCore.psm1" -Force

    function New-TestEvent {
        param(
            [string]$Channel = 'System',
            [string]$ProviderName = 'disk',
            [int]$Id = 51,
            [int]$Level = 2,
            [datetime]$TimeCreated = ([datetime]'2026-08-02T04:00:00Z'),
            [string]$Message = 'test message'
        )
        [pscustomobject]@{
            Channel      = $Channel
            ProviderName = $ProviderName
            Id           = $Id
            Level        = $Level
            TimeCreated  = $TimeCreated
            Message      = $Message
        }
    }

    $script:Now = [datetime]'2026-08-02T05:15:00Z'
}

Describe 'Select-BriefEvent' {

    Context 'time window' {
        It 'keeps an event inside the window' {
            $e = New-TestEvent -TimeCreated ([datetime]'2026-08-01T06:00:00Z')
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now -WindowHours 24)
            $r.Count | Should -Be 1
        }

        It 'drops an event older than the window' {
            $e = New-TestEvent -TimeCreated ([datetime]'2026-07-31T06:00:00Z')
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now -WindowHours 24)
            $r.Count | Should -Be 0
        }
    }

    Context 'level policy' {
        It 'keeps Critical and Error on System' {
            $events = @(
                (New-TestEvent -Level 1 -Id 41),
                (New-TestEvent -Level 2 -Id 51)
            )
            $r = @(Select-BriefEvent -Events $events -Now $script:Now)
            $r.Count | Should -Be 2
        }

        It 'drops Warning and Information on System' {
            $events = @(
                (New-TestEvent -Level 3 -Id 219),
                (New-TestEvent -Level 4 -Id 16)
            )
            $r = @(Select-BriefEvent -Events $events -Now $script:Now)
            $r.Count | Should -Be 0
        }

        It 'keeps Informational service-install 7045 on System despite level policy' {
            $e = New-TestEvent -Level 4 -Id 7045 -ProviderName 'Service Control Manager'
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now)
            $r.Count | Should -Be 1
        }

        It 'keeps Informational firewall rule changes' {
            $e = New-TestEvent -Channel 'Firewall' -Level 4 -Id 2004 -ProviderName 'Microsoft-Windows-Windows Firewall With Advanced Security'
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now)
            $r.Count | Should -Be 1
        }

        It 'keeps Informational failed logon 4625 on Security' {
            $e = New-TestEvent -Channel 'Security' -Level 4 -Id 4625 -ProviderName 'Microsoft-Windows-Security-Auditing'
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now)
            $r.Count | Should -Be 1
        }

        It 'drops an unlisted Informational id on Security' {
            $e = New-TestEvent -Channel 'Security' -Level 4 -Id 4624 -ProviderName 'Microsoft-Windows-Security-Auditing'
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now)
            $r.Count | Should -Be 0
        }

        It 'drops events from a channel with no policy' {
            $e = New-TestEvent -Channel 'Setup' -Level 2
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now)
            $r.Count | Should -Be 0
        }
    }

    Context 'allowlist suppression' {
        It 'suppresses a provider+id pair on the allowlist' {
            $e = New-TestEvent -ProviderName 'NoisyDriver' -Id 999
            $allow = @([pscustomobject]@{ provider = 'NoisyDriver'; id = 999 })
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now -Allowlist $allow)
            $r.Count | Should -Be 0
        }

        It 'does not suppress a matching id under a different provider' {
            $e = New-TestEvent -ProviderName 'OtherDriver' -Id 999
            $allow = @([pscustomobject]@{ provider = 'NoisyDriver'; id = 999 })
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now -Allowlist $allow)
            $r.Count | Should -Be 1
        }
    }

    Context 'deduplication' {
        It 'collapses repeats into one entry with an occurrence count' {
            $events = @(
                (New-TestEvent -TimeCreated ([datetime]'2026-08-01T22:00:00Z') -Message 'first'),
                (New-TestEvent -TimeCreated ([datetime]'2026-08-02T01:00:00Z') -Message 'middle'),
                (New-TestEvent -TimeCreated ([datetime]'2026-08-02T04:00:00Z') -Message 'latest')
            )
            $r = @(Select-BriefEvent -Events $events -Now $script:Now)
            $r.Count            | Should -Be 1
            $r[0].occurrences   | Should -Be 3
            $r[0].message       | Should -Be 'latest'
            $r[0].firstSeen     | Should -Match '^2026-08-01T22:00:00'
            $r[0].lastSeen      | Should -Match '^2026-08-02T04:00:00'
        }

        It 'keeps distinct ids separate' {
            $events = @(
                (New-TestEvent -Id 51),
                (New-TestEvent -Id 52)
            )
            $r = @(Select-BriefEvent -Events $events -Now $script:Now)
            $r.Count | Should -Be 2
        }
    }

    Context 'output shape' {
        It 'renders level as a name and timestamps as ISO-8601 UTC' {
            $e = New-TestEvent -Level 1
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now)
            $r[0].level     | Should -Be 'Critical'
            $r[0].firstSeen | Should -Match 'Z$'
        }

        It 'returns an empty array for no input' {
            $r = @(Select-BriefEvent -Events @() -Now $script:Now)
            $r.Count | Should -Be 0
        }
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

```powershell
Invoke-Pester .\connectors\winevents\WinEventsCore.Tests.ps1 -Output Detailed
```

Expected: FAIL — `WinEventsCore.psm1` does not exist.

- [ ] **Step 4: Write the module**

Create `connectors/winevents/WinEventsCore.psm1`:

```powershell
Set-StrictMode -Version Latest

# Per-channel inclusion policy. An event is kept if its Level is in Levels OR
# its Id is in AlwaysIds. AlwaysIds exists because the security-relevant events
# we care about (service installs, firewall rule changes, failed logons) are
# logged at Informational level and would be dropped by a level filter alone.
$script:ChannelPolicy = @{
    'System'      = @{ Levels = @(1, 2); AlwaysIds = @(7045) }
    'Application' = @{ Levels = @(1, 2); AlwaysIds = @() }
    'Firewall'    = @{ Levels = @();     AlwaysIds = @(2004, 2005, 2006, 2009, 2033) }
    'Security'    = @{ Levels = @();     AlwaysIds = @(4625, 4719, 4672, 5152, 5157) }
}

# Short name -> real Windows log name.
$script:ChannelMap = [ordered]@{
    'System'      = 'System'
    'Application' = 'Application'
    'Firewall'    = 'Microsoft-Windows-Windows Firewall With Advanced Security/Firewall'
    'Security'    = 'Security'
}

function Get-LevelName {
    param([int]$Level)
    switch ($Level) {
        1 { 'Critical' }
        2 { 'Error' }
        3 { 'Warning' }
        4 { 'Information' }
        default { "Level$Level" }
    }
}

function Select-BriefEvent {
    <#
    .SYNOPSIS
      Filter and deduplicate normalized event records. Pure - no event log access.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Events,
        [Parameter(Mandatory)][datetime]$Now,
        [int]$WindowHours = 24,
        [AllowEmptyCollection()][object[]]$Allowlist = @()
    )

    $cutoff = $Now.AddHours(-$WindowHours)

    $kept = foreach ($e in $Events) {
        if ($e.TimeCreated -lt $cutoff) { continue }

        if (-not $script:ChannelPolicy.Contains($e.Channel)) { continue }
        $policy = $script:ChannelPolicy[$e.Channel]

        $levelOk = $policy.Levels -contains $e.Level
        $idOk    = $policy.AlwaysIds -contains $e.Id
        if (-not ($levelOk -or $idOk)) { continue }

        $suppressed = $false
        foreach ($a in $Allowlist) {
            if ($a.provider -eq $e.ProviderName -and [int]$a.id -eq $e.Id) {
                $suppressed = $true
                break
            }
        }
        if ($suppressed) { continue }

        $e
    }

    $kept = @($kept)
    if ($kept.Count -eq 0) { return @() }

    $groups = $kept | Group-Object -Property { "$($_.Channel)|$($_.ProviderName)|$($_.Id)" }

    foreach ($g in $groups) {
        $sorted = @($g.Group | Sort-Object TimeCreated)
        [pscustomobject]@{
            channel     = $sorted[0].Channel
            provider    = $sorted[0].ProviderName
            id          = $sorted[0].Id
            level       = Get-LevelName -Level $sorted[0].Level
            firstSeen   = $sorted[0].TimeCreated.ToUniversalTime().ToString('o')
            lastSeen    = $sorted[-1].TimeCreated.ToUniversalTime().ToString('o')
            occurrences = $sorted.Count
            message     = $sorted[-1].Message
        }
    }
}

Export-ModuleMember -Function Select-BriefEvent, Get-LevelName
```

- [ ] **Step 5: Run tests to verify they pass**

```powershell
Invoke-Pester .\connectors\winevents\WinEventsCore.Tests.ps1 -Output Detailed
```

Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add connectors/winevents/WinEventsCore.psm1 connectors/winevents/WinEventsCore.Tests.ps1
git commit -m "feat(winevents): add deterministic event filtering core"
```

---

### Task 2: Digest assembly and channel availability

**Files:**
- Modify: `connectors/winevents/WinEventsCore.psm1`
- Modify: `connectors/winevents/WinEventsCore.Tests.ps1`
- Create: `connectors/winevents/winevents-allowlist.json`

**Interfaces:**
- Consumes: `Select-BriefEvent` from Task 1.
- Produces: `Get-BriefDigest -WindowHours <int> -AllowlistPath <string>` returns `[pscustomobject]@{ generatedAt; windowHours; channelsRead; channelsUnavailable; events }`. `channelsUnavailable` is an array of `@{ channel; reason }`.
- Produces: `Get-NormalizedEvent -Raw <object> -Channel <string>` converting a `Get-WinEvent` record to the Task 1 normalized shape.

**Why `channelsUnavailable` matters:** if Security cannot be read, the brief must say so. A missing signal that reads as a quiet night is worse than an error.

- [ ] **Step 1: Write the failing tests**

Append to `connectors/winevents/WinEventsCore.Tests.ps1`:

```powershell
Describe 'Get-NormalizedEvent' {
    It 'maps a Get-WinEvent-shaped record to the normalized shape' {
        $raw = [pscustomobject]@{
            ProviderName = 'disk'
            Id           = 51
            Level        = 2
            TimeCreated  = [datetime]'2026-08-02T04:00:00Z'
            Message      = 'disk error'
        }
        $n = Get-NormalizedEvent -Raw $raw -Channel 'System'
        $n.Channel      | Should -Be 'System'
        $n.ProviderName | Should -Be 'disk'
        $n.Id           | Should -Be 51
        $n.Level        | Should -Be 2
        $n.Message      | Should -Be 'disk error'
    }

    It 'substitutes an empty string for a null message' {
        $raw = [pscustomobject]@{
            ProviderName = 'disk'; Id = 51; Level = 2
            TimeCreated  = [datetime]'2026-08-02T04:00:00Z'
            Message      = $null
        }
        $n = Get-NormalizedEvent -Raw $raw -Channel 'System'
        $n.Message | Should -Be ''
    }
}

Describe 'Get-BriefDigest' {
    It 'reports the channels it could read against a live machine' {
        $d = Get-BriefDigest -WindowHours 24
        $d.channelsRead         | Should -Not -BeNullOrEmpty
        $d.channelsRead         | Should -Contain 'System'
        $d.windowHours          | Should -Be 24
        $d.generatedAt          | Should -Match 'Z$'
        $d.PSObject.Properties.Name | Should -Contain 'channelsUnavailable'
        $d.PSObject.Properties.Name | Should -Contain 'events'
    }

    It 'records Security under channelsUnavailable when it cannot be read' {
        $d = Get-BriefDigest -WindowHours 24
        $secReadable = $d.channelsRead -contains 'Security'
        $secListedUnavailable = @($d.channelsUnavailable | Where-Object { $_.channel -eq 'Security' }).Count -gt 0
        # Exactly one must be true - Security is never silently absent.
        ($secReadable -bxor $secListedUnavailable) | Should -BeTrue
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
Invoke-Pester .\connectors\winevents\WinEventsCore.Tests.ps1 -Output Detailed
```

Expected: FAIL — `Get-NormalizedEvent` and `Get-BriefDigest` are not defined.

- [ ] **Step 3: Create the allowlist file**

Create `connectors/winevents/winevents-allowlist.json`. Starts empty; entries get added as real noise is observed.

```json
{
  "comment": "Suppress known-benign recurring events. Match is provider + id. Add entries only after confirming the event is genuinely benign on this machine.",
  "suppress": []
}
```

- [ ] **Step 4: Implement**

Add to `connectors/winevents/WinEventsCore.psm1`, before `Export-ModuleMember`:

```powershell
function Get-NormalizedEvent {
    param(
        [Parameter(Mandatory)][object]$Raw,
        [Parameter(Mandatory)][string]$Channel
    )
    $msg = $Raw.Message
    if ($null -eq $msg) { $msg = '' }
    [pscustomobject]@{
        Channel      = $Channel
        ProviderName = $Raw.ProviderName
        Id           = [int]$Raw.Id
        Level        = [int]$Raw.Level
        TimeCreated  = $Raw.TimeCreated
        Message      = $msg
    }
}

function Get-BriefDigest {
    <#
    .SYNOPSIS
      Query every configured channel, filter, and assemble the digest payload.
    #>
    param(
        [int]$WindowHours = 24,
        [string]$AllowlistPath = "$PSScriptRoot\winevents-allowlist.json"
    )

    $now    = [datetime]::UtcNow
    $cutoff = $now.AddHours(-$WindowHours)

    $allowlist = @()
    if (Test-Path $AllowlistPath) {
        $parsed = Get-Content $AllowlistPath -Raw | ConvertFrom-Json
        if ($parsed.PSObject.Properties.Name -contains 'suppress') {
            $allowlist = @($parsed.suppress)
        }
    }

    $read        = [System.Collections.Generic.List[string]]::new()
    $unavailable = [System.Collections.Generic.List[object]]::new()
    $normalized  = [System.Collections.Generic.List[object]]::new()

    foreach ($short in $script:ChannelMap.Keys) {
        $logName = $script:ChannelMap[$short]
        $raw = $null
        try {
            $raw = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $cutoff } -ErrorAction Stop)
        }
        catch {
            # Get-WinEvent raises a terminating error rather than returning empty
            # when nothing matches. That is a successful read of an empty window,
            # not an unavailable channel.
            if ($_.Exception.Message -like '*No events were found*') {
                $read.Add($short)
                continue
            }
            $unavailable.Add([pscustomobject]@{
                channel = $short
                reason  = $_.Exception.Message.Split([char]10)[0].Trim()
            })
            continue
        }

        $read.Add($short)
        foreach ($r in $raw) {
            $normalized.Add((Get-NormalizedEvent -Raw $r -Channel $short))
        }
    }

    [pscustomobject]@{
        generatedAt         = $now.ToString('o')
        windowHours         = $WindowHours
        channelsRead        = @($read)
        channelsUnavailable = @($unavailable)
        events              = @(Select-BriefEvent -Events @($normalized) -Now $now -WindowHours $WindowHours -Allowlist $allowlist)
    }
}
```

Update the export line:

```powershell
Export-ModuleMember -Function Select-BriefEvent, Get-LevelName, Get-NormalizedEvent, Get-BriefDigest
```

- [ ] **Step 5: Run tests to verify they pass**

```powershell
Invoke-Pester .\connectors\winevents\WinEventsCore.Tests.ps1 -Output Detailed
```

Expected: PASS, 19 tests. The Security test passes whichever way group membership currently sits.

- [ ] **Step 6: Eyeball a real digest**

```powershell
Import-Module .\connectors\winevents\WinEventsCore.psm1 -Force
(Get-BriefDigest -WindowHours 24) | ConvertTo-Json -Depth 5
```

Expected: valid JSON, `channelsRead` includes System/Application/Firewall, `events` is a plausible size. If it exceeds ~40 entries, note the noisiest `provider`+`id` pairs — they are allowlist candidates, but do not add them yet.

- [ ] **Step 7: Commit**

```bash
git add connectors/winevents/
git commit -m "feat(winevents): add digest assembly with channel availability reporting"
```

---

### Task 3: HTTP listener with token auth

**Files:**
- Create: `connectors/winevents/winevents-collector.ps1`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `Get-BriefDigest` from Task 2.
- Produces: `GET /health` -> `{"ok":true,"version":"1"}`; `GET /events?hours=N` -> digest JSON. Both require header `X-Brief-Token`. Missing/wrong token -> 401 with `{"error":"unauthorized"}`.

- [ ] **Step 1: Generate the token and record it**

```powershell
$tok = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\OpenClawBrief" | Out-Null
$tokFile = "$env:LOCALAPPDATA\OpenClawBrief\winevents.token"
Set-Content -Path $tokFile -Value $tok -NoNewline -Encoding ascii
icacls $tokFile /inheritance:r /grant:r "$($env:USERNAME):(R)" | Out-Null
"token written to $tokFile"
Add-Content -Path .\.env -Value "WINEVENTS_TOKEN=$tok"
"appended WINEVENTS_TOKEN to .env"
```

Verify `.env` is still ignored — it must never be staged:

```bash
git check-ignore -v .env
```

Expected: prints the matching `.gitignore` rule.

- [ ] **Step 2: Document the variable in the template**

Append to `.env.example`:

```
# Shared secret between the Windows event collector and the container-side MCP
# shim. Generate with the snippet in the winevents-bridge plan (Task 3 Step 1),
# which writes it both here and to
# %LOCALAPPDATA%\OpenClawBrief\winevents.token for the collector to read.
WINEVENTS_TOKEN=
```

- [ ] **Step 3: Write the collector**

Create `connectors/winevents/winevents-collector.ps1`:

```powershell
<#
.SYNOPSIS
  Serve filtered Windows event digests over loopback HTTP for the OpenClaw
  morning brief.

.DESCRIPTION
  Binds 127.0.0.1 only. The OpenClaw container reaches this through the
  winevents-fwd socat forwarder, which lives in WSL's network namespace and can
  therefore use the shared loopback that mirrored networking provides.

  Runs unelevated. Security-log access comes from Event Log Readers group
  membership; if that is absent the digest reports Security under
  channelsUnavailable rather than silently omitting the category.
#>

param(
    [int]$Port = 18790,
    [string]$TokenPath = "$env:LOCALAPPDATA\OpenClawBrief\winevents.token",
    [string]$LogPath = "$env:LOCALAPPDATA\OpenClawBrief\collector.log"
)

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\WinEventsCore.psm1" -Force

function Write-Log {
    param([string]$Message)
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Test-TokenEqual {
    # Constant-time comparison. Length is not secret; content is.
    param([string]$A, [string]$B)
    if ($null -eq $A -or $null -eq $B) { return $false }
    $ba = [System.Text.Encoding]::ASCII.GetBytes($A)
    $bb = [System.Text.Encoding]::ASCII.GetBytes($B)
    if ($ba.Length -ne $bb.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $ba.Length; $i++) { $diff = $diff -bor ($ba[$i] -bxor $bb[$i]) }
    return ($diff -eq 0)
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

if (-not (Test-Path $TokenPath)) { throw "token file not found at $TokenPath" }
$expectedToken = (Get-Content $TokenPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($expectedToken)) { throw "token file is empty" }

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Log "listening on 127.0.0.1:$Port"

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $req = $ctx.Request
        $res = $ctx.Response
        $res.ContentType = 'application/json'

        try {
            $supplied = $req.Headers['X-Brief-Token']
            if (-not (Test-TokenEqual -A $supplied -B $expectedToken)) {
                $res.StatusCode = 401
                $body = '{"error":"unauthorized"}'
                Write-Log "401 $($req.Url.AbsolutePath)"
            }
            elseif ($req.Url.AbsolutePath -eq '/health') {
                $res.StatusCode = 200
                $body = '{"ok":true,"version":"1"}'
            }
            elseif ($req.Url.AbsolutePath -eq '/events') {
                $hours = 24
                $raw = $req.QueryString['hours']
                if ($raw) {
                    $parsed = 0
                    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 168) {
                        $hours = $parsed
                    }
                }
                $digest = Get-BriefDigest -WindowHours $hours
                $body = $digest | ConvertTo-Json -Depth 5 -Compress
                $res.StatusCode = 200
                Write-Log "200 /events hours=$hours events=$($digest.events.Count)"
            }
            else {
                $res.StatusCode = 404
                $body = '{"error":"not found"}'
            }
        }
        catch {
            $res.StatusCode = 500
            $msg = $_.Exception.Message.Replace('"', "'").Split([char]10)[0]
            $body = "{`"error`":`"$msg`"}"
            Write-Log "500 $($req.Url.AbsolutePath) - $msg"
        }

        $buf = [System.Text.Encoding]::UTF8.GetBytes($body)
        $res.ContentLength64 = $buf.Length
        $res.OutputStream.Write($buf, 0, $buf.Length)
        $res.OutputStream.Close()
    }
}
finally {
    $listener.Stop()
    $listener.Close()
    Write-Log "stopped"
}
```

- [ ] **Step 4: Verify by hand**

In one terminal:

```powershell
pwsh -NoProfile -File .\connectors\winevents\winevents-collector.ps1
```

In a second terminal:

```powershell
$tok = (Get-Content "$env:LOCALAPPDATA\OpenClawBrief\winevents.token" -Raw).Trim()
"--- no token (expect 401) ---"
try { Invoke-WebRequest http://127.0.0.1:18790/health -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
"--- wrong token (expect 401) ---"
try { Invoke-WebRequest http://127.0.0.1:18790/health -Headers @{'X-Brief-Token'='wrong'} -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
"--- good token (expect 200) ---"
(Invoke-WebRequest http://127.0.0.1:18790/health -Headers @{'X-Brief-Token'=$tok} -UseBasicParsing).Content
"--- events ---"
(Invoke-WebRequest "http://127.0.0.1:18790/events?hours=24" -Headers @{'X-Brief-Token'=$tok} -UseBasicParsing).Content | ConvertFrom-Json | Format-List
```

Expected: `401`, `401`, `{"ok":true,"version":"1"}`, then a digest object. Stop the collector with Ctrl+C.

- [ ] **Step 5: Commit**

```bash
git add connectors/winevents/winevents-collector.ps1 .env.example
git commit -m "feat(winevents): add loopback HTTP collector with token auth"
```

---

### Task 4: Logon scheduled task

**Files:**
- Create: `register-winevents-task.ps1`

**Interfaces:**
- Produces: scheduled task `OpenClaw - winevents collector`, 45s logon delay, unelevated, no window.

The 45s delay is deliberately longer than the Ollama task's 30s: the collector is not on the critical path for 07:15 and should not compete with model loading during the boot storm.

- [ ] **Step 1: Write the registration script**

Create `register-winevents-task.ps1`:

```powershell
<#
.SYNOPSIS
  Register the Windows event collector as a logon scheduled task.

.DESCRIPTION
  Mirrors the "Ollama - autostart at logon" task. Unelevated by design - the
  collector only needs Event Log Readers group membership to reach the Security
  channel, and an always-on elevated process feeding an LLM is a far larger
  blast radius than a read-only reporting job justifies.
#>

$ErrorActionPreference = 'Stop'

$taskName = 'OpenClaw - winevents collector'
$script   = Join-Path $PSScriptRoot 'connectors\winevents\winevents-collector.ps1'

if (-not (Test-Path $script)) { throw "collector not found at $script" }

$action = New-ScheduledTaskAction -Execute 'pwsh.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = 'PT45S'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description 'Serves filtered Windows event digests on 127.0.0.1:18790 for the OpenClaw morning brief. Unelevated by design.' `
    -Force | Out-Null

Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
```

`ExecutionTimeLimit` is `[TimeSpan]::Zero` (unlimited) because this is a long-running listener, not a one-shot — the Ollama task's 5-minute limit would kill it mid-service.

- [ ] **Step 2: Register and verify**

```powershell
.\register-winevents-task.ps1
Start-ScheduledTask -TaskName 'OpenClaw - winevents collector'
Start-Sleep -Seconds 5
$tok = (Get-Content "$env:LOCALAPPDATA\OpenClawBrief\winevents.token" -Raw).Trim()
(Invoke-WebRequest http://127.0.0.1:18790/health -Headers @{'X-Brief-Token'=$tok} -UseBasicParsing).Content
```

Expected: `{"ok":true,"version":"1"}`

- [ ] **Step 3: Commit**

```bash
git add register-winevents-task.ps1
git commit -m "feat(winevents): register collector as unelevated logon task"
```

---

### Task 5: Container plumbing — forwarder and connectors volume

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: `winevents-fwd` container republishing `127.0.0.1:18790` on `172.17.0.1:18790`; named volume `openclaw-connectors` mounted at `/opt/connectors` in the openclaw container.

- [ ] **Step 1: Add the forwarder service**

In `docker-compose.yml`, after the `ollama-fwd` service:

```yaml
  # Same namespace-bridging problem as ollama-fwd: the Windows event collector
  # binds 127.0.0.1, which a bridge-network container cannot reach. This sits in
  # WSL's namespace and republishes it on the docker0 gateway.
  #
  # connect-timeout=5 is mandatory - see the ollama-fwd comment. Without it a
  # stopped collector presents to the agent as a multi-minute hang instead of an
  # immediate error.
  winevents-fwd:
    image: alpine/socat
    container_name: winevents-fwd
    network_mode: host
    command: TCP-LISTEN:18790,fork,reuseaddr,bind=172.17.0.1 TCP:127.0.0.1:18790,connect-timeout=5
    restart: unless-stopped
```

- [ ] **Step 2: Add the connectors volume**

In the `openclaw` service's `volumes:` block, add a second entry:

```yaml
    volumes:
      - openclaw-config:/home/node/.openclaw
      # Connector source, deployed by deploy-connectors.ps1. A named volume
      # rather than a /mnt/c bind: keeps node_modules on the WSL filesystem with
      # correct uid-1000 ownership. Git remains the source of truth.
      - openclaw-connectors:/opt/connectors
```

And in the top-level `volumes:` block:

```yaml
volumes:
  openclaw-config:
  openclaw-connectors:
  signal-cli-data:
```

- [ ] **Step 3: Bring it up and verify both directions**

```bash
cd /c/Users/briem/Documents/OpenClaw && docker compose up -d
```

```bash
docker exec openclaw sh -lc 'mkdir -p /opt/connectors/.probe && echo ok > /opt/connectors/.probe/w && cat /opt/connectors/.probe/w && rm -rf /opt/connectors/.probe'
```

Expected: `ok` — the volume is writable by uid 1000.

Then check the container can reach the collector. Run this in PowerShell — do not
try to interpolate the token across shells, it is fragile and leaks the value into
shell history:

```powershell
$tok = (Get-Content "$env:LOCALAPPDATA\OpenClawBrief\winevents.token" -Raw).Trim()
docker exec openclaw curl -sS -m 10 -o /dev/null `
  -w 'http=%{http_code} total=%{time_total}s\n' `
  -H "X-Brief-Token: $tok" http://host.docker.internal:18790/health
```

Expected: `http=200`.

- [ ] **Step 4: Verify the fail-fast path**

```powershell
Stop-ScheduledTask -TaskName 'OpenClaw - winevents collector'
Get-Process pwsh -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*winevents-collector*' } | Stop-Process -Force
```

```bash
docker exec openclaw curl -sS -m 30 -o /dev/null -w 'total=%{time_total}s\n' http://host.docker.internal:18790/health; echo "exit=$?"
```

Expected: total ~5s, not 30s. This is the regression guard for the failure mode that caused four silent cron failures.

Restart it:

```powershell
Start-ScheduledTask -TaskName 'OpenClaw - winevents collector'
```

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(winevents): add socat forwarder and connectors volume"
```

---

### Task 6: Node MCP stdio shim

**Files:**
- Create: `connectors/gbrief-winevents/package.json`
- Create: `connectors/gbrief-winevents/index.mjs`
- Create: `connectors/gbrief-winevents/index.test.mjs`

**Interfaces:**
- Consumes: the collector's `GET /events?hours=N` from Task 3.
- Produces: MCP tool `windows_events_digest`, one optional integer param `hours` (default 24, clamped 1..168). Returns the digest JSON as text content. On transport failure returns `{"ok":false,"error":"..."}` as content rather than throwing, so the brief can report a collection failure instead of dying.
- Produces: exported `fetchDigest(baseUrl, token, hours, fetchImpl)` for testing.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "gbrief-winevents",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `connectors/gbrief-winevents/index.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDigest, clampHours } from './index.mjs';

test('clampHours defaults to 24', () => {
  assert.equal(clampHours(undefined), 24);
  assert.equal(clampHours(null), 24);
});

test('clampHours bounds the range', () => {
  assert.equal(clampHours(0), 1);
  assert.equal(clampHours(500), 168);
  assert.equal(clampHours(48), 48);
});

test('fetchDigest returns parsed body on success', async () => {
  const stub = async (url, opts) => {
    assert.match(url, /hours=12/);
    assert.equal(opts.headers['X-Brief-Token'], 'tok');
    return { ok: true, status: 200, json: async () => ({ events: [], windowHours: 12 }) };
  };
  const r = await fetchDigest('http://c:18790', 'tok', 12, stub);
  assert.equal(r.ok, undefined);
  assert.equal(r.windowHours, 12);
});

test('fetchDigest returns a structured error on non-200', async () => {
  const stub = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r = await fetchDigest('http://c:18790', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /401/);
});

test('fetchDigest returns a structured error when the collector is unreachable', async () => {
  const stub = async () => { throw new Error('connect ECONNREFUSED'); };
  const r = await fetchDigest('http://c:18790', 'tok', 24, stub);
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});
```

- [ ] **Step 3: Push the source into the container so tests can run**

There is no Node on Windows, so the tests only run inside the container. Task 7
automates this; do it by hand here so the TDD cycle actually closes.

```powershell
docker exec openclaw rm -rf /opt/connectors/gbrief-winevents
docker cp .\connectors\gbrief-winevents openclaw:/opt/connectors/gbrief-winevents
docker exec openclaw npm install --prefix /opt/connectors/gbrief-winevents --silent
```

- [ ] **Step 4: Run tests to verify they fail**

```bash
docker exec openclaw sh -lc 'cd /opt/connectors/gbrief-winevents && npm test'
```

Expected: FAIL — `Cannot find module` / `index.mjs` does not exist.

- [ ] **Step 5: Implement**

Create `connectors/gbrief-winevents/index.mjs`:

```javascript
#!/usr/bin/env node
/**
 * MCP stdio server exposing the Windows event collector as a single tool.
 *
 * Transport only - all filtering lives in WinEventsCore.psm1 on the Windows
 * side, where it is unit-testable against synthetic events.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const BASE_URL = process.env.WINEVENTS_URL ?? 'http://host.docker.internal:18790';
const TOKEN = process.env.WINEVENTS_TOKEN ?? '';
const TIMEOUT_MS = 10_000;

export function clampHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return 24;
  return Math.min(168, Math.max(1, Math.trunc(n)));
}

export async function fetchDigest(baseUrl, token, hours, fetchImpl = fetch) {
  const url = `${baseUrl}/events?hours=${clampHours(hours)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'X-Brief-Token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `collector returned HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: `collector unreachable: ${err.message}` };
  }
}

const server = new Server(
  { name: 'gbrief-winevents', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'windows_events_digest',
      description:
        'Filtered Windows event log digest for this machine: Critical/Error system and application events, firewall rule changes, service installs, and failed logons. Already deduplicated and noise-filtered. Returns channelsUnavailable when a log could not be read.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: {
            type: 'integer',
            description: 'Lookback window in hours (1-168). Defaults to 24.',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'windows_events_digest') {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const digest = await fetchDigest(BASE_URL, TOKEN, req.params.arguments?.hours);
  return { content: [{ type: 'text', text: JSON.stringify(digest, null, 2) }] };
});

// Only connect stdio when run as the entrypoint, so tests can import cleanly.
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 6: Redeploy and run tests to verify they pass**

```powershell
docker cp .\connectors\gbrief-winevents\index.mjs openclaw:/opt/connectors/gbrief-winevents/index.mjs
```

```bash
docker exec openclaw sh -lc 'cd /opt/connectors/gbrief-winevents && npm test'
```

Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add connectors/gbrief-winevents/
git commit -m "feat(winevents): add MCP stdio shim for the event collector"
```

---

### Task 7: Deploy, register, and verify end to end

**Files:**
- Create: `deploy-connectors.ps1`

**Interfaces:**
- Consumes: everything above.
- Produces: an `openclaw mcp` server named `gbrief-winevents` that probes clean.

- [ ] **Step 1: Write the deploy script**

Create `deploy-connectors.ps1`:

```powershell
<#
.SYNOPSIS
  Deploy connector source into the openclaw container's connectors volume.

.DESCRIPTION
  Git is the source of truth; the container gets a copy. A named volume is used
  rather than a /mnt/c bind mount so node_modules lives on the WSL filesystem
  with correct uid-1000 ownership.
#>

$ErrorActionPreference = 'Stop'

$connectors = @('gbrief-winevents')

foreach ($name in $connectors) {
    $src = Join-Path $PSScriptRoot "connectors\$name"
    if (-not (Test-Path $src)) { throw "connector source not found: $src" }

    Write-Host "deploying $name..." -NoNewline
    docker exec openclaw rm -rf "/opt/connectors/$name"
    docker cp "$src" "openclaw:/opt/connectors/$name"
    docker exec openclaw npm install --prefix "/opt/connectors/$name" --omit=dev --silent
    Write-Host " done."
}

Write-Host "reloading MCP runtimes..."
docker exec openclaw openclaw mcp reload
```

- [ ] **Step 2: Deploy**

```powershell
.\deploy-connectors.ps1
```

Expected: `deploying gbrief-winevents... done.`

- [ ] **Step 3: Run the shim's tests inside the container**

```bash
docker exec openclaw sh -lc 'cd /opt/connectors/gbrief-winevents && npm install --silent && npm test'
```

Expected: 5 tests pass.

- [ ] **Step 4: Register the MCP server**

`$WINEVENTS_TOKEN` is expanded *inside* the container, not on Windows — the
container picked it up from `.env` via `env_file` when Task 5 recreated it. This
keeps the token out of Windows shell history. Confirm it is present first:

```bash
docker exec openclaw sh -lc 'test -n "$WINEVENTS_TOKEN" && echo "token present" || echo "MISSING - recreate the container so env_file reloads .env"'
```

```bash
docker exec openclaw sh -lc 'openclaw mcp add gbrief-winevents \
  --command node \
  --arg /opt/connectors/gbrief-winevents/index.mjs \
  --env WINEVENTS_URL=http://host.docker.internal:18790 \
  --env WINEVENTS_TOKEN="$WINEVENTS_TOKEN" \
  --include windows_events_digest \
  --timeout 30'
```

`mcp add` probes before saving, so a failure here means the shim did not start.

- [ ] **Step 5: Probe**

```bash
docker exec openclaw openclaw mcp probe gbrief-winevents
```

Expected: lists `windows_events_digest`.

- [ ] **Step 6: End-to-end through an agent turn**

```bash
docker exec openclaw openclaw agent --agent main \
  --message 'Call the windows_events_digest tool with hours=24 and report only: how many events it returned, and the exact contents of channelsRead and channelsUnavailable. Do not summarize the events themselves.' \
  --verbose on --json 2>&1 | tail -30
```

Expected: `toolSummary` shows `windows_events_digest` with 0 failures, and the reply names the channels. If `channelsUnavailable` contains Security, the Event Log Readers group membership has not taken effect — confirm the group was added and that a logoff/logon has happened since.

- [ ] **Step 7: Record the `--tools` finding**

The spec flags an unverified assumption: whether `cron edit --tools` can scope MCP tool names. Check it now that a real MCP tool exists.

```bash
docker exec openclaw openclaw cron edit d8951ae5-a8b9-4e2f-8704-c3ab9bfaa227 --tools windows_events_digest 2>&1 | tail -5
docker exec openclaw openclaw cron get d8951ae5-a8b9-4e2f-8704-c3ab9bfaa227 2>&1 | grep -A5 -i tools
```

Record the outcome in the spec under the "Unverified assumption" callout — either it works and phase 3 uses `--tools`, or it does not and phase 3 uses the dedicated-agent fallback. Then revert the change, because phase 1 is not the right moment to alter the live job:

```bash
docker exec openclaw openclaw cron edit d8951ae5-a8b9-4e2f-8704-c3ab9bfaa227 --clear-tools
```

- [ ] **Step 8: Commit**

```bash
git add deploy-connectors.ps1 docs/superpowers/specs/2026-08-02-morning-brief-connectors-design.md
git commit -m "feat(winevents): deploy script and MCP registration; record --tools finding"
```

---

## Definition of Done

- [ ] `Invoke-Pester .\connectors\winevents\WinEventsCore.Tests.ps1` — 19 passing
- [ ] `npm test` in `/opt/connectors/gbrief-winevents` — 5 passing
- [ ] Collector survives a reboot and answers `/health` without manual intervention
- [ ] A dead collector fails in ~5s, not 240s
- [ ] `openclaw mcp probe gbrief-winevents` lists the tool
- [ ] An agent turn successfully calls the tool
- [ ] `channelsUnavailable` correctly reports Security when it is not readable
- [ ] `git status` clean; `.env` never staged

## Deferred to later phases

- Google connector (phase 2) — needs the user's Google Cloud OAuth client
- Brief prompt rewrite, `--agent local_heavy`, 27B latency measurement, tool scoping (phase 3)
- Allowlist tuning — deliberately starts empty; entries get added from observed noise
