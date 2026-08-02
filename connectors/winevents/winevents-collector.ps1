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

New-Item -ItemType Directory -Force -Path (Split-Path $LogPath) | Out-Null

if (-not (Test-Path $TokenPath)) { throw "token file not found at $TokenPath" }
$expectedToken = (Get-Content $TokenPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($expectedToken)) { throw "token file is empty" }

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Log "listening on 127.0.0.1:$Port"

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
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
            $msg = $_.Exception.Message.Replace('"', "'").Split([char]10)[0]
            $body = "{`"error`":`"$msg`"}"
            Write-Log "500 $($req.Url.AbsolutePath) - $msg"
        }

        $buf = [System.Text.Encoding]::UTF8.GetBytes($body)
        $res.ContentLength64 = $buf.Length
        $res.OutputStream.Write($buf, 0, $buf.Length)
        $res.OutputStream.Close()
    }
}
finally {
    $listener.Stop()
    $listener.Close()
    Write-Log "stopped"
}
