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
| `register-winevents-task.ps1` | Registers the logon + daily-07:05 scheduled task. Runs the collector directly under Windows PowerShell 5.1 - no launcher script. |
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
function Select-ValidAllowlistEntry {
    <#
    .SYNOPSIS
      Validate and normalize allowlist entries, separating valid from malformed.
    .DESCRIPTION
      An entry is valid only if it has a non-empty string provider AND an id that coerces to int.
      Tolerates: non-numeric id, missing provider, missing id, bare strings, etc.
      Never throws.
    #>
    param(
        [AllowEmptyCollection()][object[]]$Raw = @()
    )

    $valid = [System.Collections.Generic.List[object]]::new()
    $errors = [System.Collections.Generic.List[object]]::new()

    foreach ($e in $Raw) {
        if ($null -eq $e) {
            $errors.Add([pscustomobject]@{
                entry  = 'null'
                reason = 'entry is null'
            })
            continue
        }

        $hasProvider = $false
        $providerValue = $null
        $hasId = $false
        $idValue = $null

        if ($e.PSObject.Properties.Name -contains 'provider') {
            $providerValue = $e.provider
            $hasProvider = $true
        }

        if ($e.PSObject.Properties.Name -contains 'id') {
            $idValue = $e.id
            $hasId = $true
        }

        $reason = $null
        $isValid = $false

        if (-not $hasProvider) {
            $reason = 'missing provider'
        } elseif ([string]::IsNullOrWhiteSpace($providerValue)) {
            $reason = 'provider is empty'
        } elseif (-not $hasId) {
            $reason = 'missing id'
        } else {
            $idInt = $null
            try {
                $idInt = [int]$idValue
                $isValid = $true
            } catch {
                $reason = "id '$idValue' is not numeric"
            }

            if ($isValid) {
                $valid.Add([pscustomobject]@{
                    provider = [string]$providerValue
                    id       = $idInt
                })
            }
        }

        if (-not $isValid) {
            $entryStr = if ($e -is [string]) { $e } else { ($e | ConvertTo-Json -Compress) }
            $errors.Add([pscustomobject]@{
                entry  = $entryStr
                reason = $reason
            })
        }
    }

    @{
        Valid  = @($valid)
        Errors = @($errors)
    }
}

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

    $rawAllowlist = @()
    $allowlistErrors = @()
    if (Test-Path $AllowlistPath) {
        try {
            $parsed = Get-Content $AllowlistPath -Raw | ConvertFrom-Json
            if ($parsed.PSObject.Properties.Name -contains 'suppress') {
                $suppressValue = $parsed.suppress
                if ($null -ne $suppressValue) {
                    if ($suppressValue -is [array]) {
                        $rawAllowlist = @($suppressValue)
                    } else {
                        $rawAllowlist = @($suppressValue)
                    }
                }
            }
        } catch {
            $allowlistErrors += [pscustomobject]@{
                entry  = 'allowlist file'
                reason = "JSON parse error: $($_.Exception.Message)"
            }
        }
    }

    $validated = Select-ValidAllowlistEntry -Raw $rawAllowlist
    $allowlist = $validated.Valid
    $allowlistErrors += @($validated.Errors)

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
            if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound,*') {
                $read.Add($short)
                continue
            }
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
        allowlistErrors     = @($allowlistErrors)
        events              = @(Select-BriefEvent -Events @($normalized) -Now $now -WindowHours $WindowHours -Allowlist $allowlist)
    }
}
```

Update the export line:

```powershell
Export-ModuleMember -Function Select-BriefEvent, Get-LevelName, Get-NormalizedEvent, Get-BriefDigest, Select-ValidAllowlistEntry
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
.\rotate-winevents-token.ps1
```

> **Superseded (final review).** The original snippet here was:
>
> ```powershell
> $tok = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
> ...
> Add-Content -Path .\.env -Value "WINEVENTS_TOKEN=$tok"
> ```
>
> Three problems, all of which `rotate-winevents-token.ps1` fixes:
>
> 1. **`Add-Content` appends.** Running it twice left `.env` with TWO
>    `WINEVENTS_TOKEN=` lines and the effective value was whichever the parser
>    took last. Rotation is exactly the case where it gets run twice.
> 2. **It knew about two of the three copies.** The token also lives
>    **cleartext** in `mcp.servers.gbrief-winevents.env.WINEVENTS_TOKEN` inside
>    `openclaw.json`, because openclaw does not pass its own environment to the
>    stdio MCP servers it spawns (measured — see the script's `.DESCRIPTION`).
>    Following the old procedure left the shim sending a stale token and the
>    chain returning 401, visible only inside a tool result nobody reads.
> 3. **`Get-Random` is not a cryptographic RNG.**
>
> The script updates all three copies in the order that works (`.env` ->
> recreate container -> re-register MCP server -> token file -> restart
> collector), verifies by SHA-256 digest that the container really reloaded,
> and proves the chain answers 200 from both sides — without printing the
> value.

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

  This script can be dot-sourced (". .\winevents-collector.ps1") to load its
  functions - e.g. New-ErrorJson - for testing, without starting the listener.
  The listener only starts when the script is invoked normally (run directly,
  or via "pwsh -File").
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

function New-ErrorJson {
    # Builds a guaranteed-valid single-line JSON error body from an arbitrary
    # exception message. Exception messages routinely contain Windows paths
    # (backslashes) and can be multi-line or CRLF-terminated; hand-built JSON
    # string interpolation only escaped double quotes and split on LF, which
    # left backslashes and stray CR bytes in the output and produced invalid
    # JSON. ConvertTo-Json handles all string escaping (backslash, quote,
    # control characters) correctly, so build the body through it instead.
    param([string]$Message)

    if ([string]::IsNullOrEmpty($Message)) {
        $Message = 'unknown error'
    }

    # Take the first line only, regardless of line-ending style (LF, CRLF, or
    # a lone CR), so the response body stays a single readable line.
    $firstLine = ($Message -split "`r`n|`r|`n")[0]

    # Strip any remaining C0 control characters (0x00-0x1F), including a
    # trailing CR that a lone-CR split would otherwise leave behind.
    $clean = -join ($firstLine.ToCharArray() | Where-Object { [int]$_ -ge 0x20 })

    if ([string]::IsNullOrWhiteSpace($clean)) {
        $clean = 'unknown error'
    }

    return (@{ error = $clean } | ConvertTo-Json -Compress)
}

function Start-WinEventsCollector {
    <#
    .SYNOPSIS
      Start the loopback listener and serve requests until stopped.
    .DESCRIPTION
      Split out from script top level so the script can be dot-sourced for
      testing (e.g. New-ErrorJson, or the exit-code contract below) without
      binding a socket in the cases that do not require one.

      Exit-code contract (read by Task Scheduler's RestartCount supervision -
      see register-winevents-task.ps1): this function RETURNS an int exit
      code rather than calling `exit` itself, so it stays callable from
      Pester without killing the test process; the script's own top-level
      invocation (bottom of this file) is what actually calls `exit` with
      that value when run as a real process.

        0   = deliberate/clean shutdown - GetContext() observed the listener
              is no longer listening (Stop()/Close() called from elsewhere).
              This is the "nothing is wrong" case.
        1   = abnormal termination - token file missing/empty, the listener
              failed to Start() (e.g. port already in use), or the
              give-up-after-N-consecutive-GetContext-failures path. Task
              Scheduler must see this as a failure so RestartCount kicks in.

      This distinction matters because a pwsh script that reaches the end of
      its execution with no explicit exit code returns 0 regardless of what
      happened inside - a `break` out of the request loop is not, by itself,
      a signal of anything. Every abnormal path below sets $exitCode before
      falling through to the shared cleanup and return.
    #>
    param(
        [int]$Port,
        [string]$TokenPath,
        [string]$LogPath
    )

    # Write-Log and Test-TokenEqual are defined at script scope and read/use
    # $LogPath from that scope; keep it in sync with the value this run was
    # started with.
    $script:LogPath = $LogPath

    New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

    $exitCode = 0
    $listener = $null

    try {
        if (-not (Test-Path $TokenPath)) { throw "token file not found at $TokenPath" }
        # Get-Content -Raw returns $null (not '') for a genuinely zero-byte
        # file, which would otherwise throw a confusing null-reference error
        # from .Trim() instead of the intended "token file is empty" message.
        $rawToken = Get-Content $TokenPath -Raw
        if ($null -eq $rawToken) { $rawToken = '' }
        $expectedToken = $rawToken.Trim()
        if ([string]::IsNullOrWhiteSpace($expectedToken)) { throw "token file is empty" }

        $listener = [System.Net.HttpListener]::new()
        $listener.Prefixes.Add("http://127.0.0.1:$Port/")

        try {
            $listener.Start()
        }
        catch {
            # The real protection against two collectors racing for this
            # port is Task Scheduler's MultipleInstances=IgnoreNew (set
            # explicitly in register-winevents-task.ps1) - this script does
            # not pre-check the port and is not itself idempotent. This
            # catch exists for the case that protection does not apply,
            # e.g. an unrelated process (or a manually-started second copy
            # outside Task Scheduler's control) already holds the port. Fail
            # loudly with a clear log line and a non-zero exit rather than
            # letting an unhandled HttpListenerException propagate.
            Write-Log "FAILED to start listener - port $Port already in use or otherwise unavailable: $($_.Exception.Message)"
            throw
        }

        Write-Log "listening on 127.0.0.1:$Port"

        # This runs unattended as a logon scheduled task, reached through a
        # socat forwarder from a container. Client disconnects (forwarder
        # restarts, curl -m timeouts, container churn) are routine, not
        # exceptional, and must never take the listener down.
        # Consecutive-failure counter guards against a hot spin if
        # GetContext starts failing repeatedly for a reason that is not a
        # client hangup (e.g. a transport-level problem) - a short sleep
        # backs off between retries, and after a threshold we give up and
        # log why rather than burn CPU forever. Giving up here is an
        # abnormal exit (sets $exitCode = 1, see the contract above) -
        # Task Scheduler's restart supervision is what is supposed to bring
        # the collector back, not a silent "logged it and moved on".
        $consecutiveFailures = 0
        $maxConsecutiveFailures = 10

        while ($listener.IsListening) {
            $ctx = $null
            try {
                $ctx = $listener.GetContext()
                $consecutiveFailures = 0
            }
            catch {
                # Deliberate shutdown (Stop()/Close() called from elsewhere,
                # or GetContext invoked after disposal) - exit the loop
                # cleanly instead of treating it as a transient error.
                # $exitCode stays 0: this is the "nothing is wrong" path.
                if (-not $listener.IsListening) { break }

                $consecutiveFailures++
                Write-Log "GetContext error ($consecutiveFailures/$maxConsecutiveFailures): $($_.Exception.Message)"
                if ($consecutiveFailures -ge $maxConsecutiveFailures) {
                    Write-Log "too many consecutive GetContext failures, giving up"
                    $exitCode = 1
                    break
                }
                Start-Sleep -Milliseconds 200
                continue
            }

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
                $body = New-ErrorJson -Message $_.Exception.Message
                Write-Log "500 $($req.Url.AbsolutePath) - $($_.Exception.Message)"
            }

            # A client that disconnected mid-response (forwarder restart,
            # timed-out curl on the container side) makes Write()/Close()
            # throw. That is expected, not fatal - log it and move on to the
            # next request rather than letting it escape the loop and take
            # the whole listener down.
            try {
                $buf = [System.Text.Encoding]::UTF8.GetBytes($body)
                $res.ContentLength64 = $buf.Length
                $res.OutputStream.Write($buf, 0, $buf.Length)
                $res.OutputStream.Close()
            }
            catch {
                Write-Log "response write failed for $($req.Url.AbsolutePath) (client likely disconnected): $($_.Exception.Message)"
            }
        }
    }
    catch {
        # Covers: token file missing/empty, listener.Start() failure
        # (rethrown from the nested catch above), or any other unexpected
        # error. All of these are abnormal - Task Scheduler must see a
        # non-zero exit so RestartCount supervision applies.
        Write-Log "FATAL: $($_.Exception.Message)"
        $exitCode = 1
    }
    finally {
        if ($listener) {
            try { if ($listener.IsListening) { $listener.Stop() } } catch { }
            try { $listener.Close() } catch { }
        }
        Write-Log "stopped (exit code $exitCode)"
    }

    return $exitCode
}

# Only start the listener when the script is invoked directly (run as a file,
# or via "pwsh -File"), not when it is dot-sourced to load functions for
# testing. When dot-sourced, $MyInvocation.InvocationName is ".".
if ($MyInvocation.InvocationName -ne '.') {
    exit (Start-WinEventsCollector -Port $Port -TokenPath $TokenPath -LogPath $LogPath)
}
```

> **Amended after review (fix round 1):** the code block above reflects the
> shipped script, not the original plan draft. The original draft's 500
> handler built JSON via string interpolation (only escaping double quotes,
> splitting on LF alone), which emitted invalid JSON for messages containing
> Windows paths (backslashes) or CRLF line endings - both routine in
> exception messages on this platform. It also called `GetContext()` and
> wrote the response outside any try/catch that could survive a client
> disconnect, so one dropped connection (routine across the socat forwarder)
> took the whole unattended listener down until the next interactive logon.
> Both are fixed above: `New-ErrorJson` builds the error body through
> `ConvertTo-Json` instead of string interpolation, and the loop body is
> restructured so `GetContext()` failures and response-write failures are
> each caught locally, logged, and treated as "move on to the next request"
> rather than "crash the listener." See
> `.superpowers/sdd/2026-08-02-winevents-bridge/task-3-report.md` for the
> full fix report and verification evidence.
>
> **Amended after review (Task 4, fix round 1):** the code block above also
> reflects a second fix, made while implementing Task 4's registration
> script. The give-up-after-10-consecutive-GetContext-failures path used to
> `break` with no explicit exit code, so it fell off the end of the script
> and returned 0 - indistinguishable from a clean shutdown to Task
> Scheduler's RestartCount supervision, which only restarts on a non-zero
> result. That silently defeated the entire point of Task 4's restart
> policy for exactly the failure it exists to cover. Fixed by giving
> `Start-WinEventsCollector` an explicit exit-code contract (0 = deliberate
> shutdown, 1 = abnormal termination), documented in the function's
> `.DESCRIPTION` above, and returning that value instead of calling `exit`
> directly (so the function stays callable from Pester without killing the
> test process - the real `exit` call moved to the script's top-level
> invocation). The same pass also made `$listener.Start()` fail gracefully
> (logged, non-zero exit) instead of throwing an unhandled
> `HttpListenerException` on a port collision, and fixed a pre-existing bug
> where `Get-Content -Raw` on a genuinely zero-byte token file returns
> `$null`, which crashed `.Trim()` with a confusing null-reference error
> instead of the intended "token file is empty" message. See
> `.superpowers/sdd/2026-08-02-winevents-bridge/task-4-report.md` for the
> full fix report, live exit-code demonstrations, and verification
> evidence.

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
- Produces: scheduled task `OpenClaw - winevents collector`, two triggers
  (logon with 45s delay, and daily at 07:05 local), unelevated, no window.

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

  Two triggers are registered on the same task: at logon (45s delay), and
  daily at 07:05 local time as a safety net so a collector that died
  earlier is back up ten minutes before the 07:15 morning brief cron, even
  if the machine was never logged out overnight.

  MultipleInstances=IgnoreNew is set explicitly - it is what actually
  prevents two collectors racing for port 18790 when triggers land close
  together, not any idempotency in the collector script itself (it has
  none; a second HttpListener.Start() against a held port throws).

  RestartCount=1440 (1/minute for 24h) is deliberately generous: the
  collector can exit non-zero on its own after sustained transport failure
  (see winevents-collector.ps1's exit-code contract), and this is the
  supervision that is supposed to bring it back.

  Execute is the stable System32 Windows PowerShell 5.1 binary running the
  collector script DIRECTLY - no launcher process in between. pwsh.exe
  (PowerShell 7) is never invoked by this task at all: the collector runs
  fine under 5.1 (empirically verified - see task-4-report.md fix round 2),
  and 5.1's own path never moves or gets version-pinned the way pwsh's MSIX
  install path does. Running it directly (rather than through a launcher
  that then execs pwsh) also means Task Scheduler supervises the one real
  process - Stop-ScheduledTask actually stops the collector, with nothing
  left orphaned holding port 18790.
#>

$ErrorActionPreference = 'Stop'

$taskName = 'OpenClaw - winevents collector'
$script   = Join-Path $PSScriptRoot 'connectors\winevents\winevents-collector.ps1'

if (-not (Test-Path $script)) { throw "collector not found at $script" }

$stablePwsh51 = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path $stablePwsh51)) { throw "Windows PowerShell not found at $stablePwsh51" }

$action = New-ScheduledTaskAction -Execute $stablePwsh51 `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logonTrigger.Delay = 'PT45S'

$dailyTrigger = New-ScheduledTaskTrigger -Daily -At '07:05'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 1440 `
    -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logonTrigger, $dailyTrigger) `
    -Settings $settings -Principal $principal `
    -Description 'Serves filtered Windows event digests on 127.0.0.1:18790 for the OpenClaw morning brief. Unelevated by design.' `
    -Force | Out-Null

Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
```

`ExecutionTimeLimit` is `[TimeSpan]::Zero` (unlimited) because this is a long-running listener, not a one-shot - the Ollama task's 5-minute limit would kill it mid-service.

> **Amended after review (Task 4, fix round 1):** the code block above
> reflects the shipped script, not the original plan draft (reproduced
> below the amendment note in `task-4-report.md`'s history for reference).
> Three defects surfaced in review:
>
> 1. `RestartCount 3` with a 1-minute interval only buys 3 minutes of
>    retrying before Task Scheduler gives up - nowhere near enough for a
>    collector that must reliably be up daily at 07:15. Raised to 1440
>    (1/minute for 24h, covering the gap until the next daily/logon trigger
>    anyway).
> 2. The task had only a logon trigger, so a collector that died while the
>    user stayed logged in for days would stay dead until the next logon -
>    potentially never reaching the 07:15 morning brief. Added a daily
>    07:05 local trigger as a safety net.
> 3. `-Execute 'pwsh.exe'` fails under Task Scheduler on this machine:
>    Task Scheduler builds its child process environment from the
>    persisted Machine/User `PATH`, which resolves a bare `pwsh.exe` to the
>    0-byte App Execution Alias stub (a reparse point requiring shell
>    activation, not a real binary), producing `ERROR_FILE_NOT_FOUND`. A
>    first fix resolved `pwsh.exe` via `$PSHOME` at registration time, but
>    that bakes in a version-pinned MSIX path that goes stale on the next
>    pwsh upgrade. The shipped fix instead adds `invoke-collector.ps1`, a
>    small launcher run by the never-version-pinned System32 Windows
>    PowerShell 5.1 binary, which resolves pwsh.exe at RUN TIME via the
>    registry "App Paths" key the pwsh installer keeps current across
>    upgrades, execs the collector, and propagates its exit code.
>
> Also fixed: the daily trigger's rationale no longer claims the collector
> is "idempotent" about the port (it is not - see the winevents-collector.ps1
> amendment note above); the real protection against two racing instances
> is this task's explicit `MultipleInstances IgnoreNew`, called out above
> rather than left as New-ScheduledTaskSettingsSet's unstated default. See
> `.superpowers/sdd/2026-08-02-winevents-bridge/task-4-report.md` for the
> full fix report, including empirical verification that the launcher
> resolves and execs pwsh correctly under a real Task Scheduler invocation
> (not just a manual one).
>
> **Amended after review (Task 4, fix round 2):** the `invoke-collector.ps1`
> launcher introduced in fix round 1 (above) is GONE - deleted entirely,
> along with every reference to it in this doc and in
> `register-winevents-task.ps1`. It solved the version-pin problem but
> introduced a second-order bug: the launcher ran the real collector as a
> child process outside any job object, so `Stop-ScheduledTask` (or
> anything else that kills the launcher without killing its child) orphaned
> the collector still holding port 18790 - confirmed independently by
> Task 5's implementer (see the Task 5 amendment note near
> "Verify the fail-fast path" below) and reproduced directly during this
> fix round (`Stop-ScheduledTask` left the task `State: Ready` with the
> collector still listening on 18790).
>
> Rather than fix the launcher (e.g. wrapping the child in a Windows job
> object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), this round tested
> whether the launcher could be removed entirely: does the collector run
> correctly under Windows PowerShell 5.1? It does - empirically verified
> with the full Pester suite (45/45 under both 5.1 and pwsh 7), the
> collector run standalone under 5.1 and exercised end to end (`/health`,
> both 401 paths, a real `/events` digest structurally diffed against the
> pwsh 7 output - identical top-level keys, identical event-object shape,
> identical ISO-8601 timestamp formatting), the port-in-use and
> empty-token non-zero exit paths, and the `Get-WinEvent`
> `NoMatchingEventsFound` `FullyQualifiedErrorId` discriminator (byte-
> identical string between editions:
> `NoMatchingEventsFound,Microsoft.PowerShell.Commands.GetWinEventCommand`).
> Since 5.1 passed, `register-winevents-task.ps1` now runs
> `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` directly
> against `winevents-collector.ps1` - no launcher, no job object, no
> version pin (5.1's own path is exactly as stable as pwsh's was
> unstable), and Task Scheduler supervises the one real process, so
> `Stop-ScheduledTask` now genuinely stops the collector (re-verified after
> this fix: task `State` goes to `Ready` AND nothing listens on 18790). See
> `task-4-report.md` fix round 2 for the full test matrix and evidence.

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
git add register-winevents-task.ps1 connectors/winevents/winevents-collector.ps1 connectors/winevents/winevents-collector.Tests.ps1
git commit -m "feat(winevents): register collector as unelevated logon+daily task"
```

---

### Task 5: Container plumbing — forwarder and connectors volume

**Files:**
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: `winevents-fwd` container republishing `127.0.0.1:18790` on `172.17.0.1:18791`; named volume `openclaw-connectors` mounted at `/opt/connectors` in the openclaw container.

> **Amended after review (Task 5, fix round 1):** the external port below is
> `18791`, not `18790`. Under WSL2 mirrored networking, Windows and WSL share
> one port space — once a Windows process holds a port number, WSL cannot bind
> that same port number on ANY address, including `172.17.0.1`, even though
> it's a different IP than the Windows listener. Verified directly: binding
> `172.17.0.1:18790` fails with `Address in use` while the Windows collector
> holds `127.0.0.1:18790`; binding `172.17.0.1:18799` (or any port Windows
> isn't using) succeeds immediately. This plan copied `ollama-fwd`'s shape
> without carrying forward the reason it uses different port numbers on each
> side (`11435` -> `11434`) — the same constraint applies here, so the
> container-facing port must differ from the collector's port too. Consumers
> reach the forwarder at `http://host.docker.internal:18791`. See
> `.superpowers/sdd/2026-08-02-winevents-bridge/task-5-report.md` for the full
> investigation.

- [ ] **Step 1: Add the forwarder service**

In `docker-compose.yml`, after the `ollama-fwd` service:

```yaml
  # Same namespace-bridging problem as ollama-fwd: the Windows event collector
  # binds 127.0.0.1, which a bridge-network container cannot reach. This sits in
  # WSL's namespace and republishes it on the docker0 gateway.
  #
  # External port is 18791, NOT 18790, even though the upstream collector is on
  # 18790 - same reason ollama-fwd is 11435 -> 11434 rather than 11434 -> 11434.
  # Under WSL2 mirrored networking, Windows and WSL share one port space: once a
  # Windows process holds a port number, WSL cannot bind that SAME port number on
  # ANY address (172.17.0.1 included), even though it's a different IP than the
  # Windows listener's 127.0.0.1. Verified directly: binding 172.17.0.1:18790
  # fails with "Address in use" while the collector holds 127.0.0.1:18790 on
  # Windows; binding 172.17.0.1:18799 (or any port Windows isn't using) succeeds
  # immediately. So the container-facing port must differ from the collector's
  # port. Consumers reach this at http://host.docker.internal:18791.
  #
  # connect-timeout=5 is mandatory - see the ollama-fwd comment. Without it a
  # stopped collector presents to the agent as a multi-minute hang instead of an
  # immediate error.
  winevents-fwd:
    image: alpine/socat
    container_name: winevents-fwd
    network_mode: host
    command: TCP-LISTEN:18791,fork,reuseaddr,bind=172.17.0.1 TCP:127.0.0.1:18790,connect-timeout=5
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
  -H "X-Brief-Token: $tok" http://host.docker.internal:18791/health
```

Expected: `http=200`.

- [ ] **Step 4: Verify the fail-fast path**

```powershell
Stop-ScheduledTask -TaskName 'OpenClaw - winevents collector'
Get-Process pwsh -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*winevents-collector*' } | Stop-Process -Force
```

```bash
docker exec openclaw curl -sS -m 30 -o /dev/null -w 'total=%{time_total}s\n' http://host.docker.internal:18791/health; echo "exit=$?"
```

Expected: total ~5s, not 30s. This is the regression guard for the failure mode that caused four silent cron failures.

> **Amended after review (Task 5, fix round 1):** `Stop-ScheduledTask` alone
> does not stop the collector — the launcher's child process is not in a job
> object, so terminating the launcher does not terminate the collector it
> spawned. The step above must be preceded by explicitly killing the orphaned
> process (identify it by command line containing `winevents-collector.ps1`)
> and confirming nothing listens on `18790` before the timing test means
> anything. See `task-5-report.md` for the exact sequence used and the
> confirmation this is a Task 4 launcher defect being tracked separately, not
> something Task 5 modifies.
>
> **Superseded (Task 4, fix round 2):** the launcher this note describes has
> been deleted. `register-winevents-task.ps1` now runs
> `winevents-collector.ps1` directly under Windows PowerShell 5.1, with
> Task Scheduler supervising that one real process - no launcher, no
> orphan. The manual-kill workaround above is no longer necessary:
> `Stop-ScheduledTask` alone now stops the collector (task `State` goes to
> `Ready` and nothing listens on `18790`), re-verified as part of this fix.
> See `.superpowers/sdd/2026-08-02-winevents-bridge/task-4-report.md` fix
> round 2 for the evidence.

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

const BASE_URL = process.env.WINEVENTS_URL ?? 'http://host.docker.internal:18791';
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

> **Superseded (final review): registration is now part of
> `deploy-connectors.ps1`**, which adds the server if absent and leaves an
> existing entry alone. Run that instead of the commands below; they are kept
> for reference because they document what the script does. Registration used
> to be a hand-run command persisted only inside the `openclaw-config` Docker
> volume — so a fresh machine, or a lost volume, produced a container with the
> connector files present and no tool registered, and nothing said so. This
> branch made the connectors volume reproducible on exactly that argument.

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
  --env WINEVENTS_URL=http://host.docker.internal:18791 \
  --env WINEVENTS_TOKEN="$WINEVENTS_TOKEN" \
  --include windows_events_digest \
  --timeout 30'
```

> **Amended after review (Task 5, fix round 1):** `WINEVENTS_URL` port changed
> from `18790` to `18791` — that is the `winevents-fwd` container-facing port,
> not the collector's own port. See the Task 5 amendment above for why the two
> must differ under WSL2 mirrored networking.

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
