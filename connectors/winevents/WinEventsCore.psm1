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

    # Validate allowlist, use only valid entries
    $validated = Select-ValidAllowlistEntry -Raw $Allowlist
    $safeAllowlist = $validated.Valid

    $kept = foreach ($e in $Events) {
        if ($e.TimeCreated -lt $cutoff) { continue }

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

    # Load and validate allowlist from JSON
    $rawAllowlist = @()
    $allowlistErrors = @()
    if (Test-Path $AllowlistPath) {
        try {
            $parsed = Get-Content $AllowlistPath -Raw | ConvertFrom-Json
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
            $raw = @(Get-WinEvent -FilterHashtable @{ LogName = $logName; StartTime = $cutoff } -ErrorAction Stop)
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

    [pscustomobject]@{
        generatedAt         = $now.ToString('o')
        windowHours         = $WindowHours
        channelsRead        = @($read)
        channelsUnavailable = @($unavailable)
        allowlistErrors     = @($allowlistErrors)
        events              = @(Select-BriefEvent -Events @($normalized) -Now $now -WindowHours $WindowHours -Allowlist $allowlist)
    }
}

Export-ModuleMember -Function Select-BriefEvent, Get-LevelName, Get-NormalizedEvent, Get-BriefDigest, Select-ValidAllowlistEntry
