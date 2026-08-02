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

**Local model tool calling: the provider was misconfigured, and a model limit sits
behind it.** An earlier version of this document said local models "cannot emit tool
calls". That was wrong about the cause. Investigated 2026-08-02:

- The models are capable. `ollama show` reports `tools` for both, and handed a
  `tools` payload directly, `qwen3.5:9b` returns a textbook structured call
  (`finish_reason: tool_calls`, correct name and arguments).
- Ollama is capable, in every shape tested: `/v1/chat/completions` and
  `/v1/responses`, streaming and non-streaming, all emit the function call.
- **The provider config was wrong twice.** No `compat.supportsTools` was declared on
  any model entry, so OpenClaw degraded to describing tools in the prompt — which is
  why the models emitted `<invoke>` and `<mcp action="callTool">` as *prose*, in
  Anthropic's syntax, rather than failing to call anything. And `api` was
  `openai-responses`, whose adapter received Ollama's stream — which demonstrably
  contains `response.function_call_arguments.done` and the tool name — but
  classified the turn "reasoning-only" and gave up after two retries. Ollama emits
  reasoning as `reasoning_summary_text`, not `reasoning_text`.
- Fixed by declaring `compat: { supportsTools: true, thinkingFormat: "qwen" }` and
  switching to the native `api: "ollama"` adapter (baseUrl drops `/v1`). The hard
  failures are gone; plain generation verified working.
- **The remaining blocker was context bulk, not tool count.** Reducing the tool set
  from ~45 to ~2 did *not* help; both the 9B and the 27B still made no call. A wire
  capture proved OpenClaw *was* sending the tools correctly (`POST /api/chat` with a
  well-formed `tools` array), and the same request replayed by hand with a
  one-sentence prompt produced a perfect `tool_calls` response. The only difference
  was prompt size: OpenClaw's default agent request is **~52 KB** of bootstrap
  files, skills, and identity context, and the 9B loses the tool-calling thread
  under it.

**Local tool calling now works.** With the provider fixed and the agent's context
trimmed, `qwen3.5:9b` calls the tool reliably against real data:

```
tools: { profile: "minimal", alsoAllow: ["gbrief-winevents__windows_events_digest"] }
contextInjection: "never"
skills: []
bootstrapTotalMaxChars: 1000

-> toolSummary: [{ calls: 1, tools: ["gbrief-winevents__windows_events_digest"], failures: 0 }]
```

**Ollama's real context is 4096 unless you say otherwise, and that silently
truncated the brief.** The provider config declared `contextWindow: 262144`, but
`ollama ps` reported `CONTEXT 4096` — Ollama's default — because OpenClaw sends
`"options":{}` with no `num_ctx`. The cron turn's ~6,000-token input therefore
overflowed the real window, leaving no room to generate: Ollama returned
`done_reason: "length"` after ~112 output tokens and the job failed with "Agent
couldn't generate a response". It was invisible from OpenClaw's side, which reported
only `stopReason=length`; a `socat -v` tap on the provider connection is what showed
Ollama's own verdict. Direct agent runs slipped under the limit and worked, which
made it look cron-specific. Fixed by declaring both, and keeping them equal so
OpenClaw budgets context against the window that actually exists:

```
params:        { num_ctx: 16384 }
contextWindow: 16384
maxTokens:     8192
```

**The morning brief now works end to end** — `status: ok`, delivered to Telegram in
23s, all three sections grounded in real events, and `sanitizedCount` correctly
surfaced in the report ("two fields/data items were truncated during sanitization").

**The trade-off is real and worth stating.** An agent configured this way has no
bootstrap files, no skills, and no injected identity — it is a narrow specialist,
not a general assistant. That suits the morning brief, which does one job. It would
not suit `main`. The 27B is still untested under trimmed context.

`claude_tasks` (haiku-4.5) and `coding_agent` (sonnet-5) call tools reliably with
full context and remain the zero-tuning option.

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
