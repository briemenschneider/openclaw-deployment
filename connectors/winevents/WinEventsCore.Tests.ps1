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

        It 'keeps an event at the exact window cutoff' {
            $cutoff = $script:Now.AddHours(-24)
            $e = New-TestEvent -TimeCreated $cutoff
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now -WindowHours 24)
            $r.Count | Should -Be 1
        }
    }

    Context 'time window across DateTimeKind boundaries' {
        # THE HOLE THESE TESTS FILL. Every other timestamp in this file is
        # built as [datetime]'...Z', which PowerShell does NOT turn into a
        # Kind=Utc value - it converts to local time and stamps the result
        # Kind=Local. So both sides of every other comparison here are Local,
        # and the mismatch that actually shipped could never surface: $Now was
        # [datetime]::UtcNow (Kind=Utc) while TimeCreated came from
        # Get-WinEvent (Kind=Local), and because DateTime comparison uses Ticks
        # and ignores Kind, a requested 24h window was applied as 26h on this
        # UTC+2 machine - and would have been 19h at UTC-5, dropping exactly
        # the overnight period the brief exists to cover. 45/45 green was real
        # and told us nothing about it.
        #
        # These tests therefore build the two sides with DIFFERENT Kinds on
        # purpose and assert the boundary in terms of REAL ELAPSED TIME.
        #
        # Honest limitation: the skew IS the machine's UTC offset, so a machine
        # at UTC+0 cannot exhibit the bug and these assertions pass there
        # either way. They are correct statements everywhere but only
        # load-bearing where the offset is non-zero. The offset is printed
        # below so a vacuous green run is visible rather than assumed.
        BeforeAll {
            $script:UtcOffset = [System.TimeZoneInfo]::Local.GetUtcOffset([datetime]::UtcNow)
            Write-Host "    [Kind-mismatch tests] machine UTC offset = $($script:UtcOffset); these assertions are vacuous at 00:00:00"
        }

        It 'drops an event 25 real hours old when Now is Kind=Utc and TimeCreated is Kind=Local' {
            $nowUtc = [datetime]::UtcNow
            # The same instant Get-WinEvent would hand us: Kind=Local.
            $old = $nowUtc.AddHours(-25).ToLocalTime()
            $nowUtc.Kind | Should -Be 'Utc'
            $old.Kind    | Should -Be 'Local'
            $r = @(Select-BriefEvent -Events @((New-TestEvent -TimeCreated $old)) -Now $nowUtc -WindowHours 24)
            $r.Count | Should -Be 0
        }

        It 'keeps an event 23 real hours old when Now is Kind=Utc and TimeCreated is Kind=Local' {
            $nowUtc = [datetime]::UtcNow
            $recent = $nowUtc.AddHours(-23).ToLocalTime()
            $r = @(Select-BriefEvent -Events @((New-TestEvent -TimeCreated $recent)) -Now $nowUtc -WindowHours 24)
            $r.Count | Should -Be 1
        }

        It 'keeps an event 23 real hours old when Now is Kind=Local and TimeCreated is Kind=Utc' {
            $nowLocal = [datetime]::Now
            $recent = $nowLocal.AddHours(-23).ToUniversalTime()
            $nowLocal.Kind | Should -Be 'Local'
            $recent.Kind   | Should -Be 'Utc'
            $r = @(Select-BriefEvent -Events @((New-TestEvent -TimeCreated $recent)) -Now $nowLocal -WindowHours 24)
            $r.Count | Should -Be 1
        }

        It 'drops an event 25 real hours old when Now is Kind=Local and TimeCreated is Kind=Utc' {
            $nowLocal = [datetime]::Now
            $old = $nowLocal.AddHours(-25).ToUniversalTime()
            $r = @(Select-BriefEvent -Events @((New-TestEvent -TimeCreated $old)) -Now $nowLocal -WindowHours 24)
            $r.Count | Should -Be 0
        }

        It 'gives one instant the same verdict however either side expresses its Kind' {
            $nowUtc   = [datetime]::UtcNow
            $nowLocal = $nowUtc.ToLocalTime()
            foreach ($hours in @(23, 25)) {
                $instantUtc   = $nowUtc.AddHours(-$hours)
                $instantLocal = $instantUtc.ToLocalTime()
                $expected = if ($hours -lt 24) { 1 } else { 0 }
                foreach ($now in @($nowUtc, $nowLocal)) {
                    foreach ($t in @($instantUtc, $instantLocal)) {
                        $r = @(Select-BriefEvent -Events @((New-TestEvent -TimeCreated $t)) -Now $now -WindowHours 24)
                        $r.Count | Should -Be $expected -Because "an event $hours real hours old with Now.Kind=$($now.Kind) and TimeCreated.Kind=$($t.Kind) must be judged on the instant, not the tick value"
                    }
                }
            }
        }

        It 'places the boundary at exactly WindowHours of real elapsed time' {
            $nowUtc = [datetime]::UtcNow
            # One second either side of a 24h boundary, expressed the way
            # Get-WinEvent returns timestamps.
            $justInside  = $nowUtc.AddHours(-24).AddSeconds(1).ToLocalTime()
            $justOutside = $nowUtc.AddHours(-24).AddSeconds(-1).ToLocalTime()
            @(Select-BriefEvent -Events @((New-TestEvent -TimeCreated $justInside))  -Now $nowUtc -WindowHours 24).Count | Should -Be 1
            @(Select-BriefEvent -Events @((New-TestEvent -TimeCreated $justOutside)) -Now $nowUtc -WindowHours 24).Count | Should -Be 0
        }

        It 'orders firstSeen and lastSeen by instant when a group mixes Kinds' {
            $nowUtc = [datetime]::UtcNow
            # Chosen so TICK order and INSTANT order disagree wherever the UTC
            # offset exceeds the 1h gap: the earlier instant is expressed as
            # Kind=Local (larger ticks by the offset) and the later one as
            # Kind=Utc, so a Sort-Object on the raw DateTime puts them the
            # wrong way round and corrupts firstSeen/lastSeen.
            $earlier = $nowUtc.AddHours(-2).ToLocalTime()   # Kind=Local, earlier instant
            $later   = $nowUtc.AddHours(-1)                 # Kind=Utc,   later instant
            $r = @(Select-BriefEvent -Events @(
                (New-TestEvent -TimeCreated $later   -Message 'later'),
                (New-TestEvent -TimeCreated $earlier -Message 'earlier')
            ) -Now $nowUtc -WindowHours 24)
            $r.Count      | Should -Be 1
            $r[0].message | Should -Be 'later'
            ([datetimeoffset]::Parse($r[0].firstSeen)).UtcDateTime | Should -Be $earlier.ToUniversalTime()
            ([datetimeoffset]::Parse($r[0].lastSeen)).UtcDateTime  | Should -Be $later.ToUniversalTime()
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

        It 'suppresses with a JSON string id normalized to int' {
            $e = New-TestEvent -ProviderName 'NoisyDriver' -Id 999
            $allow = @([pscustomobject]@{ provider = 'NoisyDriver'; id = '999' })
            $r = @(Select-BriefEvent -Events @($e) -Now $script:Now -Allowlist $allow)
            $r.Count | Should -Be 0
        }

        It 'tolerates fully malformed allowlist without throwing' {
            $e = New-TestEvent -ProviderName 'disk' -Id 51
            $malformed = @(
                [pscustomobject]@{ provider = 'OtherDriver'; id = 'not_numeric' },
                'bare string',
                [pscustomobject]@{ missingId = 'value' },
                $null
            )
            $didThrow = $false
            $result = $null
            try {
                $result = @(Select-BriefEvent -Events @($e) -Now $script:Now -Allowlist $malformed)
            } catch {
                $didThrow = $true
            }
            $didThrow | Should -Be $false
            $result.Count | Should -Be 1
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

    It 'converts TimeCreated to Kind=Utc while preserving the instant' {
        # Get-WinEvent returns Kind=Local. Normalizing here is what stops that
        # Kind travelling downstream into a comparison against a Kind=Utc
        # value - see Select-BriefEvent's .DESCRIPTION for what that cost.
        $local = [datetime]::Now
        $local.Kind | Should -Be 'Local'
        $raw = [pscustomobject]@{
            ProviderName = 'disk'; Id = 51; Level = 2
            TimeCreated  = $local
            Message      = 'disk error'
        }
        $n = Get-NormalizedEvent -Raw $raw -Channel 'System'
        $n.TimeCreated.Kind | Should -Be 'Utc'
        $n.TimeCreated      | Should -Be $local.ToUniversalTime()
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

Describe 'Select-ValidAllowlistEntry' {
    It 'accepts a valid entry with string provider and int id' {
        $raw = @([pscustomobject]@{ provider = 'disk'; id = 51 })
        $result = Select-ValidAllowlistEntry -Raw $raw
        $result.Valid.Count      | Should -Be 1
        $result.Valid[0].provider | Should -Be 'disk'
        $result.Valid[0].id       | Should -Be 51
        $result.Errors.Count      | Should -Be 0
    }

    It 'rejects an entry with non-numeric id' {
        $raw = @([pscustomobject]@{ provider = 'disk'; id = 'not_numeric' })
        $result = Select-ValidAllowlistEntry -Raw $raw
        $result.Valid.Count  | Should -Be 0
        $result.Errors.Count | Should -Be 1
        $result.Errors[0].reason | Should -Match 'not numeric'
    }

    It 'rejects an entry missing the id key' {
        $raw = @([pscustomobject]@{ provider = 'disk' })
        $result = Select-ValidAllowlistEntry -Raw $raw
        $result.Valid.Count  | Should -Be 0
        $result.Errors.Count | Should -Be 1
        $result.Errors[0].reason | Should -Match 'missing id'
    }

    It 'rejects an entry missing the provider key' {
        $raw = @([pscustomobject]@{ id = 51 })
        $result = Select-ValidAllowlistEntry -Raw $raw
        $result.Valid.Count  | Should -Be 0
        $result.Errors.Count | Should -Be 1
        $result.Errors[0].reason | Should -Match 'missing provider'
    }

    It 'rejects a bare string in the array' {
        $raw = @('bare string')
        $result = Select-ValidAllowlistEntry -Raw $raw
        $result.Valid.Count  | Should -Be 0
        $result.Errors.Count | Should -Be 1
    }

    It 'normalizes a JSON string id to int' {
        $raw = @([pscustomobject]@{ provider = 'disk'; id = '999' })
        $result = Select-ValidAllowlistEntry -Raw $raw
        $result.Valid.Count      | Should -Be 1
        $result.Valid[0].id       | Should -Be 999
        $result.Valid[0].id       | Should -BeOfType 'int'
        $result.Errors.Count      | Should -Be 0
    }

    It 'handles an empty array gracefully' {
        $result = Select-ValidAllowlistEntry -Raw @()
        $result.Valid.Count  | Should -Be 0
        $result.Errors.Count | Should -Be 0
    }

    It 'mixes valid and invalid entries, reporting both' {
        $raw = @(
            [pscustomobject]@{ provider = 'good'; id = 51 },
            [pscustomobject]@{ provider = 'bad'; id = 'notnum' },
            [pscustomobject]@{ id = 99 }
        )
        $result = Select-ValidAllowlistEntry -Raw $raw
        $result.Valid.Count  | Should -Be 1
        $result.Errors.Count | Should -Be 2
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
        $d.PSObject.Properties.Name | Should -Contain 'allowlistErrors'
    }

    It 'records Security under channelsUnavailable when it cannot be read' {
        $d = Get-BriefDigest -WindowHours 24
        $secReadable = $d.channelsRead -contains 'Security'
        $secListedUnavailable = @($d.channelsUnavailable | Where-Object { $_.channel -eq 'Security' }).Count -gt 0
        # Exactly one must be true - Security is never silently absent.
        ($secReadable -bxor $secListedUnavailable) | Should -BeTrue
    }

    It 'handles suppress that is not an array' {
        # Create a temporary allowlist with suppress as a single object
        $tmpFile = [System.IO.Path]::GetTempFileName()
        @{ suppress = [pscustomobject]@{ provider = 'test'; id = 123 } } | ConvertTo-Json | Set-Content $tmpFile
        { $d = Get-BriefDigest -AllowlistPath $tmpFile } | Should -Not -Throw
        Remove-Item $tmpFile -Force
    }

    It 'never emits an event older than the windowHours it reports' {
        # End-to-end consistency check against the live log: whatever window is
        # reported must be the window that was applied. Data-dependent (it can
        # only fail when the machine actually has an event in the over-run
        # band), which is why the deterministic version lives in the mocked
        # context below - but this one exercises the real Get-WinEvent call.
        $d = Get-BriefDigest -WindowHours 24
        $d.windowHours | Should -Be 24
        $generated = [datetimeoffset]::Parse($d.generatedAt).UtcDateTime
        foreach ($e in $d.events) {
            $first = [datetimeoffset]::Parse($e.firstSeen).UtcDateTime
            ($generated - $first).TotalHours | Should -BeLessOrEqual 24
        }
    }
}

Describe 'Get-BriefDigest time window (Get-WinEvent mocked)' {
    # Deterministic counterparts to the live-machine tests above. Mocking
    # Get-WinEvent inside the module lets these assert the exact window that is
    # requested from the event log and the exact window that is applied to what
    # comes back, without depending on what happens to be in the real log.

    It 'asks Get-WinEvent for a local-wall-clock StartTime exactly WindowHours back' {
        # Get-WinEvent reads -FilterHashtable StartTime as LOCAL wall-clock and
        # ignores its DateTimeKind entirely. Handing it a Kind=Utc value
        # therefore over- or under-shoots by the machine's UTC offset - the
        # query half of the 24h-means-26h bug. Both the Kind AND the value are
        # asserted: the Kind assertion fails against the old code even at
        # UTC+0, where the value assertion alone would pass vacuously.
        Mock -ModuleName WinEventsCore Get-WinEvent { return @() }

        $null = Get-BriefDigest -WindowHours 24

        Should -Invoke -ModuleName WinEventsCore Get-WinEvent -Times 4 -Exactly -ParameterFilter {
            $expected = [datetime]::UtcNow.AddHours(-24).ToLocalTime()
            $FilterHashtable.StartTime.Kind -eq [System.DateTimeKind]::Local -and
            [math]::Abs(($FilterHashtable.StartTime - $expected).TotalMinutes) -lt 1
        }
    }

    It 'applies the same window it reports, judging events by real elapsed time' {
        Mock -ModuleName WinEventsCore Get-WinEvent {
            if ($FilterHashtable.LogName -ne 'System') { return @() }
            # Kind=Local, exactly as the real Get-WinEvent returns them.
            @(
                [pscustomobject]@{
                    ProviderName = 'TestProvider001'; Id = 51; Level = 2
                    TimeCreated  = [datetime]::UtcNow.AddHours(-23).ToLocalTime()
                    Message      = 'inside the window'
                },
                [pscustomobject]@{
                    ProviderName = 'TestProvider002'; Id = 52; Level = 2
                    TimeCreated  = [datetime]::UtcNow.AddHours(-25).ToLocalTime()
                    Message      = 'outside the window'
                }
            )
        }

        $d = Get-BriefDigest -WindowHours 24

        $d.windowHours | Should -Be 24
        @($d.events | Where-Object { $_.provider -eq 'TestProvider001' }).Count | Should -Be 1
        @($d.events | Where-Object { $_.provider -eq 'TestProvider002' }).Count | Should -Be 0
    }

    It 'emits generatedAt and event timestamps as UTC on the wire' {
        Mock -ModuleName WinEventsCore Get-WinEvent {
            if ($FilterHashtable.LogName -ne 'System') { return @() }
            @([pscustomobject]@{
                ProviderName = 'TestProvider003'; Id = 51; Level = 2
                TimeCreated  = [datetime]::UtcNow.AddHours(-2).ToLocalTime()
                Message      = 'recent'
            })
        }

        $d = Get-BriefDigest -WindowHours 24

        $d.generatedAt        | Should -Match 'Z$'
        $d.events[0].firstSeen | Should -Match 'Z$'
        $d.events[0].lastSeen  | Should -Match 'Z$'
    }
}
