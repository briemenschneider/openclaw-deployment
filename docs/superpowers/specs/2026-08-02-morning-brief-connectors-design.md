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

- Reading or acting on message bodies. Metadata only. See Security.
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
    Get-WinEvent -> filter
    HttpListener 127.0.0.1:18790
             |                                               gbrief-winevents (stdio MCP)
             |                     winevents-fwd (socat)       -> HTTP GET  ------+
             +-------------------- 172.17.0.1:18790 <----------------------------+
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

---

## Component 1: `winevents-collector.ps1` (Windows)

**Runtime:** PowerShell 7.6.4 (present; no Node, no configured Python on Windows).

**Trigger:** Scheduled task at logon, unelevated, mirroring the existing
`Ollama - autostart at logon` task.

**Listener:** `System.Net.HttpListener` on `http://127.0.0.1:18790/`.

**Endpoints:**

| Route | Returns |
|---|---|
| `GET /health` | `{"ok":true,"version":"1"}` |
| `GET /events?hours=24` | Filtered event digest (below) |

**Auth:** Static bearer token, `X-Brief-Token` header, compared with a
constant-time check. Under mirrored networking `127.0.0.1` is shared between
Windows and WSL, so the endpoint is reachable by anything on either side — the
token is cheap insurance, not defence in depth. Token lives in `.env`
(`WINEVENTS_TOKEN`) and in a `0600` file the scheduled task reads.

**Channels:**

| Channel | Elevation | Included |
|---|---|---|
| `System` | none | yes |
| `Application` | none | yes |
| `Microsoft-Windows-Windows Firewall With Advanced Security/Firewall` | none | yes |
| `Security` | Event Log Readers group | yes, once group membership is granted |

**Filtering — deterministic, in code, not model judgment:**

- Window: last N hours, default 24, from `TimeCreated`
- Level: Critical (1) and Error (2) only for System/Application
- Firewall channel: rule add/modify/delete, and blocked-inbound events
- Security channel: failed logon (4625), new service install (7045), audit policy
  change (4719), privilege assignment (4672)
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

~60 lines of Node. Exposes one tool, `windows_events_digest`, which GETs
`http://host.docker.internal:18790/events?hours=24` with the bearer token and
returns the JSON verbatim. No logic beyond transport, error mapping, and a 10s
timeout. All filtering lives in PowerShell where it is testable against synthetic
events.

If the collector is unreachable the tool returns a structured error rather than
throwing, so the brief can report "event collection unavailable" instead of the
whole run failing.

---

## Component 4: the brief job

**Model:** `--agent local_heavy` (`ollama/qwen3.6:27b`).

The 27B is viable *specifically because of when this runs*. It needs ~17 GB and
spills past the 12 GiB 4080; at 10:00 on a working machine there is 0.2 GB
available and it would thrash. At 07:15 the machine is four minutes past a cold
boot with ~25 GB free. This is the one point in the day it fits — and that
reasoning must be preserved, because moving the job's schedule silently breaks
its model choice.

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

**Injection.** Subjects and sender names are attacker-controlled: anyone can send
mail whose subject reads like an instruction. Three layers, in order of
importance:

1. **No actuation.** The job's `--tools` allowlist has no exec, no write, no
   network. A successful injection has nothing to act on. This is the control that
   matters; the others are depth.
2. **No bodies.** Metadata-only collection removes the large majority of the
   attack surface.
3. **Framing.** The prompt states that all connector output is untrusted data.

**Credentials.** Google tokens in the config volume at `0600`, never in git.
`WINEVENTS_TOKEN` in `.env`, already gitignored. The collector runs unelevated.

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
| `winevents-collector.ps1` | Pester | 24h boundary, level filter, allowlist suppression, dedup/occurrence counting, unavailable-channel reporting, auth rejection |
| `gbrief-google` | `node:test` | fixture-driven digest shaping, **assertion that no body text appears in any output**, token refresh, API error handling |
| `gbrief-winevents` | `node:test` | passthrough, timeout, structured error on unreachable collector |
| Integration | manual | `openclaw mcp probe` both servers; `cron run` with delivery disabled before going live |

---

## Phasing

Each phase is independently useful and independently verifiable.

1. **Windows events bridge** — collector, Pester tests, scheduled task, socat
   forwarder, MCP shim. No external auth, so it is testable immediately and proves
   the transport.
2. **Google connector** — gated on the user completing Google Cloud OAuth client
   setup, which can proceed in parallel with phase 1.
3. **Brief rework** — prompt, tool scoping, 27B latency measurement, timeout,
   live dry run.

---

## Open items for the user

- Run the Event Log Readers command (supplied separately) and log off/on.
- Create a Google Cloud project with a Desktop OAuth client before phase 2.
