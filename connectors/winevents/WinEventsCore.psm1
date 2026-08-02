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
