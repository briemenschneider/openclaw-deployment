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

Describe 'Write-HttpResponseBody' {
    BeforeAll {
        # A fake HttpListenerResponse. Only the three members the function
        # touches are modelled: ContentLength64, OutputStream.Write, and
        # Close. Defined in BeforeAll, not in the Describe body - the body runs
        # during Pester's discovery phase and its functions are gone by run
        # time.
        function New-FakeResponse {
            param([switch]$WriteThrows, [switch]$CloseThrows)

            $state = [pscustomobject]@{
                Closed       = 0
                BytesWritten = $null
            }

            $stream = [pscustomobject]@{ State = $state; Fail = [bool]$WriteThrows }
            $stream | Add-Member -MemberType ScriptMethod -Name Write -Value {
                param($buffer, $offset, $count)
                if ($this.Fail) { throw 'An operation was attempted on a nonexistent network connection' }
                $this.State.BytesWritten = $buffer[$offset..($offset + $count - 1)]
            }

            $res = [pscustomobject]@{
                ContentLength64 = 0
                OutputStream    = $stream
                State           = $state
                FailClose       = [bool]$CloseThrows
            }
            $res | Add-Member -MemberType ScriptMethod -Name Close -Value {
                $this.State.Closed++
                if ($this.FailClose) { throw 'The specified network name is no longer available' }
            }
            return $res
        }
    }

    It 'writes the body and closes the response on the happy path' {
        $res = New-FakeResponse
        $failure = Write-HttpResponseBody -Response $res -Body '{"ok":true}'
        $failure               | Should -BeNullOrEmpty
        $res.State.Closed      | Should -Be 1
        $res.ContentLength64   | Should -Be 11
        [System.Text.Encoding]::UTF8.GetString([byte[]]$res.State.BytesWritten) | Should -Be '{"ok":true}'
    }

    It 'still closes the response when the write throws' {
        # The regression this exists for: the design treats a mid-response
        # client disconnect as ROUTINE, and a Close() placed after the Write()
        # in the same try block is skipped on exactly that path - leaking an
        # unterminated HttpListenerResponse every time it happens, in a process
        # meant to run for months.
        $res = New-FakeResponse -WriteThrows
        $failure = Write-HttpResponseBody -Response $res -Body '{"ok":true}'
        $failure          | Should -Match 'nonexistent network connection'
        $res.State.Closed | Should -Be 1
    }

    It 'does not throw when both the write and the close fail' {
        $res = New-FakeResponse -WriteThrows -CloseThrows
        # A hashtable, not a plain variable: Should -Not -Throw runs the
        # scriptblock in its own scope, so a plain assignment would not reach
        # this one.
        $captured = @{}
        { $captured.failure = Write-HttpResponseBody -Response $res -Body 'x' } | Should -Not -Throw
        # The write failure is the more informative of the two, so it wins.
        $captured.failure | Should -Match 'nonexistent network connection'
        $res.State.Closed | Should -Be 1
    }

    It 'reports a close failure that follows a successful write' {
        $res = New-FakeResponse -CloseThrows
        $captured = @{}
        { $captured.failure = Write-HttpResponseBody -Response $res -Body 'x' } | Should -Not -Throw
        $captured.failure | Should -Match 'close failed'
    }
}

Describe 'Start-WinEventsCollector exit code contract' {
    # These two paths both throw before the listener is ever created (the
    # token file is validated first), so they are testable in-process
    # without binding a socket. Start-WinEventsCollector returns an int
    # exit code rather than calling `exit` itself for exactly this reason -
    # see the function's .DESCRIPTION. The listener.Start()-fails
    # (port-in-use) path and the give-up-after-N-GetContext-failures path
    # both require a real listener/socket and are demonstrated live instead
    # (see task-4-report.md), not unit tested here.

    It 'returns exit code 1 when the token file does not exist' {
        $logPath = Join-Path $TestDrive 'missing-token.log'
        $code = Start-WinEventsCollector -Port 0 -TokenPath (Join-Path $TestDrive 'no-such-token') -LogPath $logPath
        $code | Should -Be 1
        (Get-Content $logPath -Raw) | Should -Match 'FATAL: token file not found'
    }

    It 'returns exit code 1 when the token file is empty' {
        $logPath = Join-Path $TestDrive 'empty-token.log'
        $tokenPath = Join-Path $TestDrive 'empty-token'
        Set-Content -Path $tokenPath -Value '' -NoNewline
        $code = Start-WinEventsCollector -Port 0 -TokenPath $tokenPath -LogPath $logPath
        $code | Should -Be 1
        (Get-Content $logPath -Raw) | Should -Match 'FATAL: token file is empty'
    }

    It 'returns exit code 1 when the token file is whitespace only' {
        $logPath = Join-Path $TestDrive 'whitespace-token.log'
        $tokenPath = Join-Path $TestDrive 'whitespace-token'
        Set-Content -Path $tokenPath -Value "   `t  " -NoNewline
        $code = Start-WinEventsCollector -Port 0 -TokenPath $tokenPath -LogPath $logPath
        $code | Should -Be 1
    }
}
