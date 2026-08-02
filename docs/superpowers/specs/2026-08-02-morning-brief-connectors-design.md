# Morning Brief Connectors — Design

**Date:** 2026-08-02
**Status:** Approved for planning
**Context:** OpenClaw personal deployment, `C:\Users\briem\Documents\OpenClaw`

---

## Problem

The `Morning brief` cron (07:15 Europe/Berlin, Telegram) has no data sources. Its
prompt asks it to "summarize my unread notes and anything due today", but nothing
is wired up, so even a correct run has nothing to report. The 2026-08-02 test run
returned a refusal to engage with the prompt at all.

We want the brief to cover three things:

1. Google Mail and Calendar — what arrived, what is scheduled today
2. Windows system health — errors and failures worth addressing
3. Windows network/firewall events — blocked traffic, rule changes, failed logons

## Non-goals

- Reading or acting on **mail** bodies. `gbrief-google` is metadata-only by
  design and by test. **This non-goal does NOT extend to Windows event
  messages**, despite how the original wording read: `gbrief-winevents` ships
  the full rendered event `Message`, and the "Output shape" example below shows
  one. That is a deliberate trade — an event id without its message is not
  actionable — but it means the metadata-only argument in Security applies to
  exactly one of the two connectors. See Security.
- Replying to mail, creating events, or any write operation anywhere.
- Real-time alerting. This is one batch report per day.
- Router or appliance logs. Scope is Windows event channels only.

---

## Architecture

Two data sources, each collected on the side of the container boundary where it
belongs, both surfaced to OpenClaw as **stdio MCP servers inside the container**.

```
  WINDOWS                          WSL2                      CONTAINER
  ---------------------------      -------------------       -------------------------
  winevents-collector.ps1
    Windows PowerShell 5.1
    Get-WinEvent -> filter
    HttpListener 127.0.0.1:18790
             |                                               gbrief-winevents (stdio MCP)
             |                     winevents-fwd (socat)       -> HTTP GET  ------+
             +-------------------- 172.17.0.1:18791 <----------------------------+
                                   connect-timeout=5

                                                             gbrief-google (stdio MCP)
                                                               -> Google API (outbound)

                                                             cron "Morning brief"
                                                               agent local_heavy (27B)
                                                               -> Telegram
```

### Why stdio MCP for both

`mcp add` supports stdio and HTTP transports. Implementing MCP's streamable-http
transport (JSON-RPC framing, session handling, SSE) in PowerShell is
disproportionate work for one read-only query. Instead the PowerShell side serves
**plain JSON over HTTP**, and a thin Node MCP shim in the container wraps it. Both
connectors are then stdio, which also means neither listens on a port and neither
needs its own auth surface.

### Why the socat forwarder

A Windows service on `127.0.0.1` is unreachable from a bridge-network container —
the same constraint that required `ollama-fwd`. `winevents-fwd` reuses that proven
pattern, with `connect-timeout=5` from the start so a dead collector fails in
seconds rather than presenting as an opaque timeout (see
`docker-compose.yml` for the full write-up of that failure mode).

**The container-facing port is 18791, not 18790, and that is not cosmetic.**
Under WSL2 mirrored networking Windows and WSL share one port namespace, so
`172.17.0.1:18790` cannot be bound at all while the Windows collector holds
`127.0.0.1:18790` — it fails with `Address in use`. 18791 is the one number
that must not be "tidied" back to match the upstream port. Same reason
`ollama-fwd` is 11435 -> 11434.

---

## Component 1: `winevents-collector.ps1` (Windows)

**Runtime: Windows PowerShell 5.1**
(`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`), permanently.
An earlier draft of this spec said PowerShell 7.6.4; that is no longer true.
Task Scheduler builds its child environment from the persisted Machine/User
PATH, which resolves a bare `pwsh.exe` to the 0-byte App Execution Alias stub
and fails with ERROR_FILE_NOT_FOUND. Resolving `$PSHOME` at registration time
bakes in a version-pinned MSIX path that goes stale on the next upgrade; a
launcher that resolved it at run time orphaned the collector on a manual stop.
The task therefore invokes the System32 5.1 binary directly, and that path is
as stable as pwsh's was unstable.

> **Consequence for contributors: the ASCII-only rule on `.ps1`/`.psm1` files
> in this connector is LOAD-BEARING, not stylistic**, and so is 5.1-compatible
> syntax. There is no pwsh 7 anywhere in the collector's runtime path. Do not
> introduce `??`, `?.`, ternaries, `Get-Error`, or any other 7.x-only
> construct, and do not assume UTF-8 source handling. Verify changes under
> Windows PowerShell 5.1, not just pwsh 7 — the Pester suite is run under
> both for this reason.

**Triggers:** two, on one unelevated scheduled task, mirroring the existing
`Ollama - autostart at logon` task:

1. **At logon**, 45s delay — the normal case of logging in fresh. Longer than
   the Ollama task's 30s because the collector is not on the critical path for
   07:15 and should not compete with model loading during the boot storm.
2. **Daily at 07:05 local** — a safety net, ten minutes before the 07:15
   morning-brief cron, so a collector that died overnight is back before the
   brief runs even if the machine was never logged out. This trigger assumes
   the machine's timezone is Europe/Berlin; `register-winevents-task.ps1`
   asserts that and refuses to register otherwise.

`MultipleInstances=IgnoreNew` — not script-level idempotence — is what
prevents the two triggers racing for port 18790.

**Listener:** `System.Net.HttpListener` on `http://127.0.0.1:18790/`.

**Endpoints:**

| Route | Returns |
|---|---|
| `GET /health` | `{"ok":true,"version":"1"}` |
| `GET /events?hours=24` | Filtered event digest (below) |

**Auth:** Static bearer token, `X-Brief-Token` header, compared with a
constant-time check. Under mirrored networking `127.0.0.1` is shared between
Windows and WSL, so the endpoint is reachable by anything on either side — the
token is cheap insurance, not defence in depth.

**The token exists in three places, and rotation must update all three:**

| Location | Read by | Notes |
|---|---|---|
| `.env` (`WINEVENTS_TOKEN`) | the container, via compose `env_file` | gitignored |
| `%LOCALAPPDATA%\OpenClawBrief\winevents.token` | the collector, once at startup | NTFS ACL restricted to the owning user with `icacls /inheritance:r` — the Windows equivalent of `0600`, not a literal mode bit. The collector must be restarted to pick up a new value. |
| `mcp.servers.gbrief-winevents.env.WINEVENTS_TOKEN` in `openclaw.json` | the MCP shim | **cleartext**, inside the `openclaw-config` volume |

The third copy is not redundant and cannot currently be removed. Measured
2026-08-02: openclaw does **not** hand its own environment to the stdio MCP
servers it spawns. A probe server that encoded env-var *presence* (never
values) into its tool name registered without `--env` probed as
`token_ABSENT__url_ABSENT__home_PRESENT`, while `WINEVENTS_TOKEN` was
demonstrably in the openclaw process's own `/proc/1/environ`; the same server
registered *with* `--env` probed as `token_PRESENT`. A SecretRef
(`{"source":"env","id":...}`, as `gateway.auth.token` uses) is rejected —
`mcp.servers.*.env` values must be strings.

Rotation order matters: update `.env`, recreate the openclaw container so
`env_file` reloads, `openclaw mcp unset gbrief-winevents` and re-run
`deploy-connectors.ps1` to re-register from the container's fresh environment,
update the token file, then restart the scheduled task. Miss the third copy and
the shim sends a stale token, the chain returns 401, and the only place it
shows is inside a tool result nobody reads.

**Channels:**

| Channel | Elevation | Included |
|---|---|---|
| `System` | none | yes |
| `Application` | none | yes |
| `Microsoft-Windows-Windows Firewall With Advanced Security/Firewall` | none | yes |
| `Security` | Event Log Readers group | yes, once group membership is granted |

**Filtering — deterministic, in code, not model judgment:**

- Window: last N hours, default 24, from `TimeCreated`, measured as REAL
  ELAPSED TIME. Every comparison is normalized to UTC first: `Get-WinEvent`
  returns `Kind=Local` timestamps and reads its own `StartTime` filter as local
  wall-clock regardless of `DateTimeKind`, while `DateTime` comparison uses
  Ticks and ignores Kind. Mixing the two silently widened the window by the
  machine's UTC offset (24h became 26h at UTC+2, and would have been 19h at
  UTC-5). See `Select-BriefEvent`'s `.DESCRIPTION`. `windowHours` in the
  payload is the window that was applied, asserted by test.
- Level: Critical (1) and Error (2) only for System/Application
- Firewall channel: rule add/modify/delete, and blocked-inbound events
  (2004, 2005, 2006, 2009, 2033)
- System channel, regardless of level: new service install (7045)
- Security channel: failed logon (4625), audit policy change (4719), special
  privileges assigned (4672), packet drop / connection blocked (5152, 5157)
- Noise allowlist: a maintained list of `{provider, id}` pairs known benign on this
  machine, in `winevents-allowlist.json` beside the script so it can be tuned
  without editing code
- Deduplication: identical `{channel, provider, id}` collapse to one entry with an
  `occurrences` count and first/last timestamps

**Output shape:**

```json
{
  "generatedAt": "2026-08-02T05:15:00Z",
  "windowHours": 24,
  "channelsRead": ["System", "Application", "Firewall", "Security"],
  "channelsUnavailable": [],
  "allowlistErrors": [],
  "events": [
    {
      "channel": "System",
      "provider": "disk",
      "id": 51,
      "level": "Error",
      "firstSeen": "2026-08-01T22:14:03Z",
      "lastSeen": "2026-08-02T04:02:11Z",
      "occurrences": 7,
      "message": "An error was detected on device \\Device\\Harddisk0\\DR0."
    }
  ]
}
```

**Load-bearing properties:**

- `channelsUnavailable`: if Security cannot be read the brief must say so rather
  than silently omit a whole category. A missing signal that looks like a quiet
  night is worse than an error.
- `allowlistErrors`: if the allowlist JSON is malformed or contains invalid
  entries, they are recorded here so the user is aware noise suppression is not
  fully applied. An allowlist with syntax errors should not silently degrade to
  no suppression.

---

## Component 2: `gbrief-google` (container, stdio MCP)

**Runtime:** Node 24 (container native). `@modelcontextprotocol/sdk` + `googleapis`.

**Scopes — read-only, minimum viable:**

- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/calendar.readonly`

**Auth flow:** The user creates a Google Cloud OAuth client (Desktop type) and runs
a one-time `authorize.mjs` that performs the loopback consent flow and writes a
refresh token to `/home/node/.openclaw/secrets/google-token.json` at `0600`. The
client secret JSON sits beside it. Neither is ever in git; both live in the config
volume, not on the Windows filesystem.

**Tools exposed:**

| Tool | Returns |
|---|---|
| `google_calendar_today` | Today's events: title, start, end, location, attendee count, all-day flag |
| `google_mail_digest` | Unread from last 24h: sender display name, sender domain, subject, timestamp, thread size. Plus totals. |

**Hard constraint: no message bodies.** `google_mail_digest` requests
`format=metadata` with an explicit `metadataHeaders` list, so bodies are never
fetched, never held in memory, and cannot leak into a tool result. This is asserted
by a unit test, not just by convention.

---

## Component 3: `gbrief-winevents` (container, stdio MCP)

~120 lines of Node. Exposes one tool, `windows_events_digest`, which GETs
`http://host.docker.internal:18791/events?hours=24` (the **forwarder's** port —
see "Why the socat forwarder") with the bearer token and returns the JSON
verbatim. No logic beyond transport, error mapping, and a 10s timeout. All
filtering lives in PowerShell where it is testable against synthetic events.

Registered by `deploy-connectors.ps1` (add-if-absent, so re-running is safe).
Its runtime tool id is `gbrief-winevents__windows_events_digest`.

If the collector is unreachable the tool returns a structured error rather than
throwing, so the brief can report "event collection unavailable" instead of the
whole run failing.

---

## Component 4: the brief job

**Model:** `--agent local_heavy` (`ollama/qwen3.6:27b`) — **not settled. See the
open risk below before building on this.**

The 27B *fits in memory* specifically because of when this runs. It needs ~17 GB
and spills past the 12 GiB 4080; at 10:00 on a working machine there is 0.2 GB
available and it would thrash. At 07:15 the machine is four minutes past a cold
boot with ~25 GB free. That reasoning must be preserved if the schedule ever
moves, because moving the job silently breaks the memory argument.

**But fitting is not the same as working.** The memory argument was the only
argument this section originally made, and it settles nothing: this branch's own
evidence has since falsified the choice on *capability*, which is a strictly
harder problem than VRAM. The 27B produced no real tool call in 3/3 attempts and
the 9B failed in 4/4. Treat the model as an open question with a memory
constraint attached, not as a decision.

> **Open risk, observed 2026-08-02 (task 7): `local_heavy` did not emit a
> single real tool call in 3/3 attempts**, against the now-real
> `gbrief-winevents__windows_events_digest` tool, same one-line prompt each
> time (`Call the windows_events_digest tool with hours=24 and report only:
> ...`), fresh session key per attempt:
>
> | attempt | timeout | result |
> |---|---|---|
> | 1 | 30s (default) | hallucinated a pseudo-XML `<invoke name="exec">...` string as plain text instead of a structured tool call |
> | 2 | 120s | timed out at the provider stage (`timeoutPhase: "provider"`) before producing any output at all |
> | 3 | 240s | hallucinated a different fake tag, `<mcp action="callTool" name="list_tools">`, again as plain text |
>
> None of the three produced a `toolSummary`, meaning the harness never
> recorded a real structured invocation — this is a distinct failure mode
> from `main` (`ollama/qwen3.5:9b`), which across 4 attempts on the same
> prompt either denied the tool existed, produced unrelated text, or narrated
> "calling" it without a real call, but never hung at the provider stage.
> Three trials is not a large sample and this was not tested against the
> actual rewritten brief prompt (still a phase-3 item) — this is a negative
> result on the current one-line prompt, not proof the 27B can never call
> tools. But it is a specific, reproduced-3-times negative result against the
> exact model this component's design depends on, and it means the prompt
> rewrite alone may not be sufficient: the harness's tool-calling handshake
> with this Ollama model may itself need verification before phase 3 treats
> `local_heavy` as reliable. Re-test after the prompt rewrite lands, with a
> larger sample, before relying on this model in production.

**Timeout:** `--timeout-seconds` set from a measured cold-start run on a realistic
payload. Not guessed. Measurement is a task in the implementation plan.

**Tools:** per-job allowlist via `--tools`, limited to the three connector tools.
The `windows_events_digest` tool's real runtime id — the only one of the three
actually registered as of task 7 — is `gbrief-winevents__windows_events_digest`
(server name + `__` + tool name; confirmed by `mcp probe` and by what agents
see in their tool list). **Use the namespaced form in the allow-list, not the
bare tool name** — see the verified callout immediately below, which found
that `--tools` does not normalize between the two forms, so writing the bare
name is silently wrong, not an equivalent shorthand. The Google tools
(`google_calendar_today`, `google_mail_digest`) are phase-2 work; their
connector server names, and therefore their final namespaced tool ids, are
not yet known and must be confirmed the same way once that connector is
registered — do not assume they'll match the bare names used here as
placeholders. The agent default is `tools.profile: coding`, which grants exec
and write; an unattended job that ingests external content must not inherit
that.

> **Verified 2026-08-02 (task 7), against a disabled throwaway cron job, not the
> live Morning brief job.** `gbrief-winevents` is registered and probes as
> `gbrief-winevents__windows_events_digest` (server name + `__` + tool name).
> Three values were tried with `cron edit --tools`:
>
> | value tried                                   | result                                    |
> |------------------------------------------------|-------------------------------------------|
> | `windows_events_digest` (bare)                  | accepted, stored verbatim                  |
> | `gbrief-winevents__windows_events_digest` (namespaced) | accepted, stored verbatim           |
> | `this_tool_does_not_exist` (garbage)             | accepted, stored verbatim                  |
>
> Every value landed unchanged in `payload.toolsAllow` (confirmed via `cron get`
> immediately after each edit). **`cron edit --tools` does no validation at
> edit time** — it does not check the string against the live tool registry,
> does not reject unknown names, and does not rewrite a bare name to its
> namespaced form (or vice versa). It is a pass-through string list.
>
> This means the CLI cannot tell us, at configuration time, whether a given
> `--tools` value will actually restrict anything when the job runs — that
> depends on how the *runtime* enforcement matches `toolsAllow` entries against
> the namespaced tool ids the agent actually sees (`server__tool`). That match
> was deliberately **not** tested live: the throwaway job's `delivery.mode` was
> `announce` to `channel: last`, and actually running it (`cron run`) risks a
> real message delivery, which is out of bounds for a phase-1 experiment. So
> the enforcement question is answered at the config layer but still open at
> the runtime layer.
>
> **Consequence for phase 3:** given edit-time acceptance of a garbage tool
> name, `--tools` cannot be trusted as a security boundary without a live-fire
> test against a real (non-disabled, non-Morning-brief) job first, checking
> that a tool *not* in the allow-list is actually refused at call time — not
> just absent from the CLI's complaints. Until that live-fire test happens,
> phase 3 should default to the dedicated-agent fallback (its own restricted
> `tools.profile` and `mcp` include-list, pointed at the 27B) as the enforced
> boundary, and treat `--tools` as, at best, defense-in-depth on top of it
> rather than the sole control.

**Prompt:** rewritten to be explicit and structured — state the role, name each
tool to call, define the output sections, and instruct that connector output is
data to be summarized rather than instructions to follow. The current one-line
prompt is what the 9B mistook for runtime noise.

**Output sections:** Calendar today · Mail summary · System health · Network and
security · Collection failures.

---

## Security

**Injection.** Attacker-influenced text reaches the model on both connector
paths: anyone can send mail whose subject reads like an instruction, and — as
detailed below — anyone who can reach an authenticating service on this machine
can put chosen text into a Windows event message.

The design calls for three layers. **State of each one at the end of phase 1,
per connector — read this table before assuming any of them protects you:**

| Layer | `gbrief-winevents` (shipped) | `gbrief-google` (phase 2, not built) |
|---|---|---|
| 1. **No actuation** — the job's agent has no exec, no write, no network, no messaging | **IN FORCE.** The brief runs on a dedicated `briefer` agent with `tools: { profile: "minimal", alsoAllow: [<the digest tool>] }`. Verified enforced, not merely configured: the gateway logs `tool policy removed 35 tool(s) via tools.profile (minimal)` on every turn, stripping `exec`, `process`, `write`, `edit`, `apply_patch`, `file_write`, `web_fetch`, `web_search`, `message`, `sessions_spawn`, `sessions_send`, `subagents`, `cron` and more. Delivery is pinned in the job (`telegram:8904877690`), not model-chosen. **NOT via `--tools`** — that is a pass-through string list which accepted `this_tool_does_not_exist` verbatim, and its runtime enforcement is still untested. | not applicable yet |
| 2. **No bodies** — metadata-only collection | **STILL FALSE — full message text ships.** Mitigated, not eliminated, by `Protect-EventMessage` (below). | designed in (`format=metadata`), unbuilt |
| 3. **Framing** — the prompt states connector output is untrusted data | **IN FORCE.** The job prompt names the threat concretely (a failed logon records an attacker-chosen account and workstation name), forbids acting on instructions found in tool output, and requires suspicious text to be reported rather than obeyed. It also forbids inventing event IDs — the local models were observed confabulating tool results. | same prompt applies |
| 4. **Detection** (added) | **IN FORCE.** `Protect-EventMessage` records which protections fired per event in a `sanitized` array, and the digest carries a top-level `sanitizedCount`. The prompt requires the brief to report a non-zero count. | n/a |

**Layer 2 mitigation — `Protect-EventMessage` in `WinEventsCore.psm1`.** Applied to
every event message before it leaves the collector, unit-tested against synthetic
input, and observed firing on real data (`sanitizedCount=2`: a 7045 installer-supplied
field capped, an over-long message truncated):

- strips control characters (tab/CR/LF kept)
- caps the fields the machine's owner does not control — `Account Name`,
  `Account Domain`, `Workstation Name`, `Process Name`, `Caller Process Name`,
  `Service Name`, `Service File Name` — to 64 chars, starving an injection of room
  without truncating the parts an operator needs
- defangs instruction-shaped markup (`<invoke`, `<mcp`, `[INST]`, `[SYS]`)
- caps total length at 500 chars

> **Change detection here must be ordinal.** PowerShell's `-eq`/`-ne` on strings is
> culture-sensitive, and .NET Core (pwsh 7) uses ICU, which treats control characters
> as *ignorable* — so `"ab" -eq "a<BEL>b"` is **true** there. The original code used
> `-ne`, which silently skipped both the flag and the assignment under pwsh 7 and left
> the control characters in place. Windows PowerShell 5.1 uses NLS and does not, which
> is the only reason the collector behaved correctly. Fixed with
> `[string]::Equals(..., [System.StringComparison]::Ordinal)`.

**What an injection can still achieve:** make the brief say something wrong. That is
the point of layer 1 — with no exec, write, network or messaging, and a pinned
delivery target, the blast radius is a misleading morning summary rather than code
execution.

**Layer 2 is false for winevents, concretely.** `WinEventsCore.psm1` puts the
full rendered event `Message` into the digest and `index.mjs` serialises it to
the model verbatim — messages up to 879 characters observed on this machine in
a routine 24h window. Two events in the inclusion policy carry
attacker-influenced fields:

- **4625 (failed logon)** embeds the *Account Name*, *Account Domain* and
  *Workstation Name* **supplied by the client**. An unauthenticated party who
  can reach any authenticating service on this machine can therefore place text
  of their choosing into a field that ends up in the model's context. No
  credentials required — a failed attempt is exactly what generates the event.
- **7045 (service install)** embeds an attacker-chosen *service name* and
  *image path*.

**This is inert today for one reason only: no model in the current stack can
emit a tool call** (3/3 and 4/4 failures, Component 4). That is a property of
the model's incapability, not of any control in this design.

> **Sequencing constraint for phase 3 — do not violate this.** A capable model
> and the injection mitigations must land **together**. Never model-first.
> Making the brief's model able to call tools, on a job that still runs with
> `tools.profile: coding` (exec + write), while ingesting attacker-influenced
> event message bodies with no framing, converts a documentation gap into
> remote code execution triggered by a failed logon. The correct order is:
> enforce a restricted tool boundary and verify it live-fire, land the framing
> prompt, decide whether message bodies are truncated/structured/dropped — and
> only then upgrade model capability.

**Credentials.** Google tokens in the config volume at `0600`, never in git.
`WINEVENTS_TOKEN` lives in three places, one of them cleartext inside the
`openclaw-config` volume — see the Auth table under Component 1 for the full
list, the measurement showing the cleartext copy cannot currently be avoided,
and the rotation order. None of them are in git. The collector runs unelevated.

**Privilege.** Security-log access comes from **Event Log Readers** group
membership, not from running elevated. An always-on elevated process feeding an
LLM is a far larger blast radius than this job justifies.

**Exposure.** The collector binds `127.0.0.1` only. It is reachable from WSL
because mirrored networking shares loopback — that is intended and is what the
forwarder relies on.

---

## Testing

| Component | Framework | Covers |
|---|---|---|
| `WinEventsCore.psm1` | Pester | 24h boundary **including deliberate DateTimeKind mismatches and the StartTime handed to `Get-WinEvent`**, level filter, allowlist validation/suppression, dedup/occurrence counting, unavailable-channel reporting |
| `winevents-collector.ps1` | Pester | error-body JSON escaping, constant-time token compare, exit-code contract, response close-on-write-failure |
| `gbrief-google` | `node:test` | fixture-driven digest shaping, **assertion that no body text appears in any output**, token refresh, API error handling |
| `gbrief-winevents` | `node:test` | passthrough, timeout vs unreachable, malformed and wrong-typed payloads, non-Error rejection values |
| Integration | manual | `openclaw mcp probe` both servers; `cron run` with delivery disabled before going live |

---

## Phasing

Each phase is independently useful and independently verifiable.

1. **Windows events bridge** — collector, Pester tests, scheduled task, socat
   forwarder, MCP shim, and its registration (both the connector source and the
   `mcp.servers` entry are reproduced by `deploy-connectors.ps1`). No external
   auth, so it is testable immediately and proves the transport. **Proves the
   transport only** — it does not make the brief work, because nothing in the
   stack can yet call the tool.
2. **Google connector** — gated on the user completing Google Cloud OAuth client
   setup, which can proceed in parallel with phase 1.
3. **Brief rework** — prompt, tool scoping, 27B latency measurement, timeout,
   live dry run.

---

## Open items for the user

- ~~Run the Event Log Readers command (supplied separately) and log off/on.~~
  Done — `Security` now appears in `channelsRead`, not `channelsUnavailable`.
- Create a Google Cloud project with a Desktop OAuth client before phase 2.
