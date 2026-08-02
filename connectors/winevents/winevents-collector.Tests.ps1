BeforeAll {
    # Dot-source the collector script to load its functions (New-ErrorJson,
    # Test-TokenEqual, Write-Log, Start-WinEventsCollector) without starting
    # the HTTP listener. The script only starts the listener when invoked
    # directly - see the $MyInvocation.InvocationName guard at the bottom of
    # winevents-collector.ps1. Dummy param values are supplied since the
    # script's param block still runs; none of them are touched unless
    # Start-WinEventsCollector is actually called, which it is not here.
    . "$PSScriptRoot\winevents-collector.ps1" -Port 0 -TokenPath 'unused' -LogPath 'unused'
}

Describe 'New-ErrorJson' {

    It 'produces valid JSON for a message containing Windows path backslashes and round-trips the path' {
        $msg = "Cannot find path 'C:\Users\briem\file.json'"
        $json = New-ErrorJson -Message $msg
        { $json | ConvertFrom-Json } | Should -Not -Throw
        $parsed = $json | ConvertFrom-Json
        $parsed.error | Should -Be $msg
    }

    It 'produces valid JSON for a CRLF-separated message with no stray CR byte' {
        $json = New-ErrorJson -Message "line one`r`nline two"
        { $json | ConvertFrom-Json } | Should -Not -Throw
        $parsed = $json | ConvertFrom-Json
        $parsed.error | Should -Be 'line one'
        # No trailing 0x0D (CR) left over from a naive LF-only split.
        $parsed.error.EndsWith([char]13) | Should -BeFalse
    }

    It 'produces valid JSON for a lone-CR-separated message with no stray CR byte' {
        $json = New-ErrorJson -Message "line one`rline two"
        { $json | ConvertFrom-Json } | Should -Not -Throw
        $parsed = $json | ConvertFrom-Json
        $parsed.error | Should -Be 'line one'
    }

    It 'produces valid JSON for a message containing a double quote' {
        $json = New-ErrorJson -Message 'bad "quoted" value'
        { $json | ConvertFrom-Json } | Should -Not -Throw
        $parsed = $json | ConvertFrom-Json
        $parsed.error | Should -Be 'bad "quoted" value'
    }

    It 'strips embedded control characters other than the line split' {
        $json = New-ErrorJson -Message "tab`there"
        { $json | ConvertFrom-Json } | Should -Not -Throw
        $parsed = $json | ConvertFrom-Json
        $parsed.error | Should -Be 'tabhere'
    }

    It 'falls back to a placeholder for an empty message' {
        $json = New-ErrorJson -Message ''
        { $json | ConvertFrom-Json } | Should -Not -Throw
        $parsed = $json | ConvertFrom-Json
        $parsed.error | Should -Be 'unknown error'
    }

    It 'falls back to a placeholder when the message is only control characters' {
        $json = New-ErrorJson -Message "`r`n"
        { $json | ConvertFrom-Json } | Should -Not -Throw
        $parsed = $json | ConvertFrom-Json
        $parsed.error | Should -Be 'unknown error'
    }
}

Describe 'Test-TokenEqual' {

    It 'returns true for identical tokens' {
        Test-TokenEqual -A 'abc123' -B 'abc123' | Should -BeTrue
    }

    It 'returns false for a wrong token of the same length' {
        Test-TokenEqual -A 'abc123' -B 'abc124' | Should -BeFalse
    }

    It 'returns false for tokens of different length' {
        Test-TokenEqual -A 'abc' -B 'abc123' | Should -BeFalse
    }

    It 'returns false when either token is null' {
        Test-TokenEqual -A $null -B 'abc123' | Should -BeFalse
        Test-TokenEqual -A 'abc123' -B $null | Should -BeFalse
    }
}
