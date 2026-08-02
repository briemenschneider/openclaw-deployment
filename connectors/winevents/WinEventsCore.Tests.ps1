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
