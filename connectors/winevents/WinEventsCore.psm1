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
        $hasProvider = $false
        $providerValue = $null
        $hasId = $false
        $idValue = $null

        # Handle null entries
        if ($null -eq $e) {
            $errors.Add([pscustomobject]@{
                entry  = 'null'
                reason = 'entry is null'
            })
            continue
        }

        # Safe property access: check existence before touching
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
        } elseif ($null -eq $idValue -or $idValue -is [bool]) {
            # These are the two JSON id types that coerce SILENTLY: [int]$null
            # is 0 and [int]$true is 1, neither throws. Without this branch,
            # {"provider":"foo","id":null} is accepted as a valid suppression
            # rule for event id 0, matches nothing, and is reported nowhere -
            # the user believes suppression is active while it quietly does
            # nothing, which is precisely the degradation allowlistErrors
            # exists to surface. Reject with a reason instead.
            $reason = if ($null -eq $idValue) { 'id is null' } else { 'id is a boolean, not a number' }
        } else {
            # Try to coerce id to int safely
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
            # Record the error with compact representation
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

function Protect-EventMessage {
    <#
    .SYNOPSIS
      Neutralize attacker-influenced text in an event message before a model sees it.

    .DESCRIPTION
      Windows event message text is NOT trusted input. Event 4625 (failed logon)
      embeds the Account Name, Account Domain and Workstation Name supplied by the
      CLIENT - a failed attempt is what generates the event, so no credentials are
      needed and anyone who can reach an authenticating service on this machine can
      write chosen text into the Security log. Event 7045 embeds an attacker-chosen
      service name and image path. Application-channel messages are arbitrary
      strings from arbitrary programs.

      All of that is forwarded to a language model, which makes it a prompt-injection
      vector. This function is DEFENCE IN DEPTH ONLY. The control that actually
      matters is that the brief's agent has no exec, write, network or messaging
      tools - see docs/winevents-known-issues.md. Never rely on this instead.

      Returns the cleaned text and the list of protections that fired, so the digest
      can report that sanitisation happened rather than doing it silently.
    #>
    param(
        [AllowNull()][AllowEmptyString()][string]$Message,
        [int]$MaxChars = 500,
        [int]$FieldMaxChars = 64
    )

    if ([string]::IsNullOrEmpty($Message)) {
        return [pscustomobject]@{ Text = ''; Flags = @() }
    }

    $flags = [System.Collections.Generic.List[string]]::new()
    $text = $Message

    # Change detection MUST be ordinal. PowerShell's -eq/-ne on strings is
    # culture-sensitive, and .NET Core (pwsh 7) uses ICU, which treats control
    # characters as IGNORABLE - so "ab" -eq "a<BEL>b" is TRUE there. Using -ne
    # here silently skipped both the flag and the assignment under pwsh 7,
    # leaving the control characters in place. Windows PowerShell 5.1 uses NLS
    # and does not, which is the only reason the collector behaved correctly.
    # Verified on this machine: inline strip worked in both editions while the
    # module comparison reported "unchanged" only under Core.
    $ord = [System.StringComparison]::Ordinal

    # 1. Control characters. Tab/CR/LF are normal in event text and are kept.
    $stripped = [regex]::Replace($text, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '')
    if (-not [string]::Equals($stripped, $text, $ord)) { $flags.Add('control-chars'); $text = $stripped }

    # 2. Cap the specific fields the machine's owner does not control. Capping
    #    these starves an injection of room without truncating the parts of the
    #    message an operator actually needs to read.
    $fieldNames = 'Account Name|Account Domain|Workstation Name|Process Name|Caller Process Name|Service Name|Service File Name'
    $lines = $text -split "`r`n|`r|`n"
    $fieldChanged = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $m = [regex]::Match($lines[$i], "(?i)^(\s*(?:$fieldNames)\s*:\s*)(.+)$")
        if ($m.Success -and $m.Groups[2].Value.Length -gt $FieldMaxChars) {
            $lines[$i] = $m.Groups[1].Value + $m.Groups[2].Value.Substring(0, $FieldMaxChars) + '...[capped]'
            $fieldChanged = $true
        }
    }
    if ($fieldChanged) { $flags.Add('field-capped'); $text = ($lines -join "`n") }

    # 3. Defang instruction-shaped markup: anything that could read as a tool call,
    #    a role marker or a template directive. This stack has already been observed
    #    emitting <invoke> and <mcp action="callTool"> tags in prose, so this is not
    #    hypothetical. ASCII-only replacements - Windows PowerShell 5.1 reads this
    #    file as ANSI.
    $defanged = [regex]::Replace($text, '<(?=[/!|A-Za-z])', '[LT]')
    $defanged = [regex]::Replace($defanged, '(?i)\[\s*/?\s*(?:INST|SYS)\s*\]', '[MARKUP]')
    if (-not [string]::Equals($defanged, $text, $ord)) { $flags.Add('markup-neutralized'); $text = $defanged }

    # 4. Length cap last, so the truncation marker survives.
    if ($text.Length -gt $MaxChars) {
        $text = $text.Substring(0, $MaxChars) + '...[truncated]'
        $flags.Add('truncated')
    }

    [pscustomobject]@{ Text = $text; Flags = @($flags) }
}

function Select-BriefEvent {
    <#
    .SYNOPSIS
      Filter and deduplicate normalized event records. Pure - no event log access.
    .DESCRIPTION
      TIME HANDLING - read this before touching any comparison below.

      System.DateTime comparison uses Ticks ONLY and ignores DateTimeKind. A
      Kind=Local value and a Kind=Utc value that denote the SAME instant have
      different Ticks (they differ by the machine's UTC offset), so comparing
      them directly skews the window by that offset - silently, and with the
      sign flipping either side of Greenwich. That is not hypothetical: it
      shipped. $Now was [datetime]::UtcNow (Kind=Utc) while TimeCreated came
      from Get-WinEvent (Kind=Local), which turned a requested 24h window into
      26h on this UTC+2 machine and would have made it 19h on a UTC-5 one -
      dropping exactly the overnight period the brief exists to cover.

      It is easy to reintroduce because PowerShell hides it: [datetime]'...Z'
      does NOT produce a Kind=Utc value, it converts to local time and stamps
      the result Kind=Local. So a test that builds both sides from Z-strings
      has two Local values and never sees the bug.

      The rule here: never compare or sort raw DateTime values. Convert every
      side to UTC with .ToUniversalTime() first - it is Kind-aware (Local
      converts, Utc is a no-op, Unspecified is treated as local, which is the
      correct reading of a Get-WinEvent timestamp). This function is exported
      and callers may hand it either Kind, so it normalizes rather than
      assuming.
    #>
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Events,
        [Parameter(Mandatory)][datetime]$Now,
        [int]$WindowHours = 24,
        [AllowEmptyCollection()][object[]]$Allowlist = @()
    )

    # Normalize to UTC BEFORE subtracting, so the cutoff is exactly
    # $WindowHours of real elapsed time from $Now whatever Kind $Now carries.
    $cutoffUtc = $Now.ToUniversalTime().AddHours(-$WindowHours)

    # Validate allowlist, use only valid entries
    $validated = Select-ValidAllowlistEntry -Raw $Allowlist
    $safeAllowlist = $validated.Valid

    $kept = foreach ($e in $Events) {
        # Both sides in UTC - see the DateTimeKind note in .DESCRIPTION.
        if ($e.TimeCreated.ToUniversalTime() -lt $cutoffUtc) { continue }

        if (-not $script:ChannelPolicy.Contains($e.Channel)) { continue }
        $policy = $script:ChannelPolicy[$e.Channel]

        $levelOk = $policy.Levels -contains $e.Level
        $idOk    = $policy.AlwaysIds -contains $e.Id
        if (-not ($levelOk -or $idOk)) { continue }

        $suppressed = $false
        foreach ($a in $safeAllowlist) {
            if ($a.provider -eq $e.ProviderName -and $a.id -eq $e.Id) {
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
        # Sort on the UTC instant, not the raw DateTime: Sort-Object compares
        # Ticks and would order a mixed-Kind group by wall-clock reading rather
        # than by when things actually happened, corrupting firstSeen/lastSeen.
        $sorted = @($g.Group | Sort-Object -Property @{ Expression = { $_.TimeCreated.ToUniversalTime() } })
        # Event message text is untrusted - see Protect-EventMessage.
        $protected = Protect-EventMessage -Message $sorted[-1].Message
        [pscustomobject]@{
            channel     = $sorted[0].Channel
            provider    = $sorted[0].ProviderName
            id          = $sorted[0].Id
            level       = Get-LevelName -Level $sorted[0].Level
            firstSeen   = $sorted[0].TimeCreated.ToUniversalTime().ToString('o')
            lastSeen    = $sorted[-1].TimeCreated.ToUniversalTime().ToString('o')
            occurrences = $sorted.Count
            message     = $protected.Text
            # Which protections fired, so sanitisation is visible rather than silent.
            sanitized   = @($protected.Flags)
        }
    }
}

function Get-NormalizedEvent {
    <#
    .SYNOPSIS
      Map a Get-WinEvent record onto the shape Select-BriefEvent consumes.
    .DESCRIPTION
      TimeCreated is converted to Kind=Utc here so that every record leaving
      this function denotes an unambiguous instant. Get-WinEvent returns
      Kind=Local; carrying that Kind downstream is what allowed the 24h window
      to become 26h (see Select-BriefEvent's .DESCRIPTION). Normalizing at the
      boundary means the rest of the module handles one Kind, and the UTC wire
      format the digest emits is then a straight ToString('o').
    #>
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
        TimeCreated  = $Raw.TimeCreated.ToUniversalTime()
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

    # Anchor everything on one UTC instant so the reported windowHours and the
    # window actually applied cannot drift apart.
    $nowUtc    = [datetime]::UtcNow
    $cutoffUtc = $nowUtc.AddHours(-$WindowHours)

    # Get-WinEvent's -FilterHashtable StartTime is interpreted as LOCAL
    # wall-clock REGARDLESS of the value's DateTimeKind - it does not convert a
    # Kind=Utc value, it reads its wall-clock fields as if they were local.
    # Verified on this machine (UTC+2): a Kind=Utc "3 hours ago" returned
    # events up to 4h45m old, while a Kind=Local "3 hours ago" returned exactly
    # 3h. So the cutoff handed to Get-WinEvent must be the local-wall-clock
    # rendering of the instant we want. Deriving it with .ToLocalTime() from
    # the UTC cutoff (rather than doing the arithmetic in local time) keeps it
    # exactly $WindowHours of REAL elapsed time even across a DST transition,
    # where local-time arithmetic would be off by an hour.
    $queryStartLocal = $cutoffUtc.ToLocalTime()

    # Load and validate allowlist from JSON
    $rawAllowlist = @()
    $allowlistErrors = @()
    if (Test-Path $AllowlistPath) {
        try {
            $parsed = Get-Content $AllowlistPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($parsed.PSObject.Properties.Name -contains 'suppress') {
                $suppressValue = $parsed.suppress
                # Handle suppress being not an array at all
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

    # Validate allowlist entries
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
            $raw = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $queryStartLocal } -ErrorAction Stop)
        }
        catch {
            # Get-WinEvent raises a terminating error rather than returning empty
            # when nothing matches. That is a successful read of an empty window,
            # not an unavailable channel.
            # Check by error ID first (locale-independent), fall back to message text.
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

    # Computed once so sanitizedCount below counts the same objects that ship.
    $selected = @(Select-BriefEvent -Events @($normalized) -Now $nowUtc -WindowHours $WindowHours -Allowlist $allowlist)

    [pscustomobject]@{
        # Wire format is UTC throughout. $nowUtc is Kind=Utc, so 'o' renders
        # the trailing 'Z' rather than a numeric offset.
        generatedAt         = $nowUtc.ToString('o')
        windowHours         = $WindowHours
        channelsRead        = @($read)
        channelsUnavailable = @($unavailable)
        allowlistErrors     = @($allowlistErrors)
        # Same $nowUtc and the same $WindowHours that are reported above, so
        # windowHours describes the window that was actually applied.
        events              = @($selected)
        # Detection signal: how many events had their message text altered by
        # Protect-EventMessage. A non-zero count on a normally-quiet machine is
        # worth looking at - it means something wrote unusual text into the log.
        sanitizedCount      = @($selected | Where-Object { @($_.sanitized).Count -gt 0 }).Count
    }
}

Export-ModuleMember -Function Select-BriefEvent, Get-LevelName, Get-NormalizedEvent, Get-BriefDigest, Select-ValidAllowlistEntry, Protect-EventMessage
