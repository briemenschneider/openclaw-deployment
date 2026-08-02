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

function Write-HttpResponseBody {
    <#
    .SYNOPSIS
      Send a response body and release the response, whether or not the send
      succeeded. Never throws.
    .DESCRIPTION
      Returns $null on success, or a message describing what went wrong.

      The Close() MUST be in a finally. A client that disconnected mid-response
      (forwarder restart, timed-out curl on the container side) makes Write()
      throw, and this design explicitly treats that as ROUTINE - so a Close()
      placed after the Write() inside the same try block is skipped on exactly
      the path that happens most often, leaking an unterminated
      HttpListenerResponse each time. In a process meant to stay up for months
      that is a slow resource leak with no symptom until it bites.

      HttpListenerResponse.Close() closes the output stream itself, so one call
      covers both. It can also throw on an already-broken connection, hence the
      inner try/catch - but a Close() failure is still reported to the caller
      rather than swallowed, unless a Write() failure already explains it.
    #>
    param(
        [Parameter(Mandatory)][object]$Response,
        [string]$Body
    )

    $failure = $null
    try {
        $buf = [System.Text.Encoding]::UTF8.GetBytes($Body)
        $Response.ContentLength64 = $buf.Length
        $Response.OutputStream.Write($buf, 0, $buf.Length)
    }
    catch {
        $failure = $_.Exception.Message
    }
    finally {
        try { $Response.Close() }
        catch {
            if ($null -eq $failure) { $failure = "close failed: $($_.Exception.Message)" }
        }
    }

    return $failure
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
            # the whole listener down. Write-HttpResponseBody never throws and
            # always closes the response; see its .DESCRIPTION.
            $writeFailure = Write-HttpResponseBody -Response $res -Body $body
            if ($null -ne $writeFailure) {
                Write-Log "response write failed for $($req.Url.AbsolutePath) (client likely disconnected): $writeFailure"
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
