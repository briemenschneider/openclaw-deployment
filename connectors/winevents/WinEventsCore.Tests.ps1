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
}
