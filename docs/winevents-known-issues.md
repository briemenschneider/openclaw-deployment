# Windows Events Bridge — Known Issues and Accepted Risks

Phase 1 shipped 2026-08-02. This records what was deliberately NOT fixed, and why,
so nobody rediscovers these as if they were new. Design detail lives in
[the spec](superpowers/specs/2026-08-02-morning-brief-connectors-design.md).

## Accepted with a ruling — reviewed and deliberately not fixed

**The UTC+0 blind spot in the window tests.** The 24-hour window bug was a
`DateTimeKind` mismatch: `Get-WinEvent` ignores `Kind` on `StartTime` and treats it
as local wall-clock. The window was really 24h + UTC offset (26h in CEST), and it
would have gone *shorter* than 24h west of UTC. Fixed, with 12 tests. But at a
machine offset of exactly UTC+0 the value-half of those tests is mathematically
vacuous — a Local and a Utc value for the same instant have identical ticks, so no
assertion can distinguish them. Two structural `Kind` assertions still catch the
bug as it shipped at any offset, and the suite prints the machine offset each run
so a vacuous pass is visible. Inherent, not fixable.

**The DST claim in `WinEventsCore.psm1` is documented but untested.** The comment
asserts correct behaviour across a DST transition. Reasoned, not covered by a test.

**`rotate-winevents-token.ps1` unregisters MCP before a deploy that can throw.** If
the deploy fails, the MCP server is left unregistered and the surfaced error is the
deploy's (e.g. a docker exit code) — nothing says the tool has vanished or that
re-running the script repairs it. Recovery is "re-run the script".

**The shim's entrypoint guard fails silently on a miss.** Now an exact
`import.meta.url` comparison rather than a suffix match, so matching is precise —
but if it ever did not match, the process would start, connect nothing, and exit 0.
Irrelevant while registration passes an absolute, non-symlinked path.

**The spec describes `gbrief-google`'s metadata-only guarantee in the present
tense** for a connector that is not built. The Security table marks it "designed in,
unbuilt", so it is not misleading in context, but the Component 2 body does not say
so on its own.

## Deferred — worth doing, not blocking

- `WinEventsCore.psm1`'s dedup group key is a `|` join; would collide if a channel or
  provider name contained a literal pipe. None of the four do.
- A dead `-is [array]` conditional in `Get-BriefDigest` with two identical branches.
- The collector's HTTP surface (routing, 401, `hours` parsing, 404, 500 wiring) has
  no automated coverage. `New-ErrorJson`, `Test-TokenEqual` and the exit codes do.
- Route matching is case-insensitive (`/HEALTH` resolves). Auth gates every route.
- `collector.log` has no rotation. Low volume.
- `Write-Log` writes raw multi-line exception text, breaking one-line-per-entry.
- `@modelcontextprotocol/sdk` is `^1.0.0` with **no committed lockfile**, in a repo
  whose compose file documents a real outage caused by floating on a tag. Commit the
  lockfile. Same policy question applies to `alpine:3.20` and the untagged
  `alpine/socat` images.
- `.gitignore` has no `node_modules` entry.
- Five citations in the tracked plan point at `.superpowers/` paths, which are
  gitignored — dead references to the evidence on a fresh clone.
- Windows PowerShell 5.1's module path has no Pester >= 5.5.0; 5.1-side test runs
  need an explicit module path or an `Install-Module` into the 5.1-scoped path.

## Things that will bite the next phase

**Local models cannot emit tool calls in this harness.** `local_heavy`
(`qwen3.6:27b`) failed 3/3; `main` (`qwen3.5:9b`) failed 4/4 — one hallucinated an
`<invoke>` tag, one an `<mcp action="callTool">` tag, one timed out with no output.
The 27B is the model the brief job design designates. Three trials is not proof it
can never call tools, but as it stands **the 07:15 brief will not call this tool**,
so phase 1 delivers no user-visible change until a capable model is wired in.
`claude_tasks` (haiku-4.5) and `coding_agent` (sonnet-5) are already configured and
call tools reliably.

**A capable model and the injection mitigations must land together, never
model-first.** The digest ships full Windows event message text to the model. Event
4625 embeds the account name, domain, and workstation name *supplied by the client
on a failed logon* — no credentials needed to write into it. Event 7045 embeds an
attacker-chosen service name and image path. None of the spec's three injection
defence layers is in force on this path today. This is inert only because no model
in the stack can act on it.

**`cron edit --tools` performs no validation whatsoever.** Bare names, namespaced
names, and entirely nonexistent tools are all accepted and persisted verbatim.
Runtime enforcement was never tested. Until it is, the trusted boundary is a
dedicated agent with its own restricted `tools.profile` and `mcp` include-list —
not the `--tools` allow-list.

**The runtime tool id is `gbrief-winevents__windows_events_digest`** (double
underscore). The bare `windows_events_digest` does not exist at runtime and
`--tools` will not normalise it.

**The token lives in three places** — `.env`, `%LOCALAPPDATA%\OpenClawBrief\winevents.token`,
and cleartext in `openclaw.json` under `mcp.servers.gbrief-winevents.env`. A stdio
MCP server does *not* inherit the container environment (verified), and
`mcp.servers.*.env` rejects a SecretRef, so the cleartext copy cannot be removed via
the CLI. Use `rotate-winevents-token.ps1`, which updates all three. A phase-3 option
worth exploring: pass `WINEVENTS_TOKEN_FILE` and have the shim read a `0600` file in
the config volume, matching the treatment the spec prescribes for the Google token.
