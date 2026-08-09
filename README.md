# OpenClaw — Docker on WSL2

Personal setup. Docker Engine in WSL2 (no Docker Desktop), OpenClaw in a container
with access to host Ollama and the Claude API.

Verified working against OpenClaw **2026.7.1**, pinned by digest
(`sha256:6a31d44b…`). See [Updating](#updating) — `:latest` is not safe here.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Container definition |
| `.env.example` | Template — copy to `.env`, fill in keys |
| `.env` | Your keys. Gitignored. Never commit. |
| `ollama-provider.patch.json5` | Ollama provider block, in `config patch` format |
| `plugins/agent-studio/` | Agent Studio dashboard plugin — see [docs/agent-studio.md](docs/agent-studio.md) |
| `deploy-agent-studio.ps1` | Build, pack, and install Agent Studio into the container |

## Setup

### 1. Keys

```bash
cp .env.example .env
# edit .env, paste the key from console.anthropic.com
```

A Claude *subscription* will not work — third-party tool quota is blocked. You need
a real API key with credits. Console and claude.ai share a login but bill
separately.

### 2. Run the onboarding wizard first

The gateway will not start without a config, so setup has to run **before** the
first `up`, not after:

```bash
cd /c/Users/briem/Documents/OpenClaw
docker compose run --rm -it openclaw openclaw setup
```

Without this, the container crash-loops on:

```
Missing config. Run `openclaw setup` or set gateway.mode=local (or pass --allow-unconfigured).
```

### 3. Make the gateway reachable

The wizard writes `gateway.bind: "loopback"`, which binds the *container's* own
loopback. A published port forwards to the container's `eth0`, never to its
loopback — so it binds successfully and is unreachable. Symptom: container healthy,
connection refused from the host.

```bash
docker compose exec openclaw node openclaw.mjs config set gateway.bind lan
```

Allowed values: `auto`, `lan`, `loopback`, `custom`, `tailnet`.

This is safe **only** because the compose file publishes to `127.0.0.1:18789:18789`
rather than a bare `18789:18789`. A bare mapping publishes on `0.0.0.0` and would
expose the gateway to the entire LAN. Do not change that line.

### 4. Start

```bash
docker compose up -d
docker compose logs -f openclaw
```

UI: **http://127.0.0.1:18789**

Use the IPv4 literal, not `localhost` — Windows resolves `localhost` to `::1`
first, and these services are IPv4-only, so it hangs until timeout rather than
failing fast. Same trap as `DOCKER_HOST`.

Auth token lives in `~/.openclaw/openclaw.json` under `gateway.auth.token`.

## Ollama

### How the container reaches it

Ollama runs on **Windows**, bound to `127.0.0.1` only. Getting a bridge-network
container to it is not obvious under WSL2 mirrored networking. Measured behavior:

| From | To | Result |
|---|---|---|
| WSL | `127.0.0.1:11434` | works — mirrored shares Windows loopback |
| WSL | `<host LAN IP>:11434` | fails |
| container | `127.0.0.1` | fails — container's own loopback |
| container | `172.17.0.1` / `host.docker.internal` | fails — nothing listening there |

Mirrored networking merges the *Windows and WSL* stacks. It does nothing for
Docker's bridge namespace, so the container has no path to WSL's loopback.

Solution: the `ollama-fwd` socat container runs with `network_mode: host`, so it
sits in WSL's namespace and can use `127.0.0.1`. It re-publishes Ollama on
`172.17.0.1:11435`, which bridge containers can reach.

```
openclaw container ──▶ host.docker.internal:11435 (172.17.0.1)
                          │
                    ollama-fwd (socat, host netns)
                          │
                          ▼
                    127.0.0.1:11434 ──▶ Ollama on Windows
```

**Ollama stays on loopback.** No `0.0.0.0` bind, no LAN exposure, no firewall rule
needed. The forwarder binds `172.17.0.1` specifically — a wildcard bind would be
exposed on the LAN under mirrored networking.

### Starting it

The Ollama tray app on this machine **fails to spawn its `serve` backend** — it
logs `"timeout waiting for Ollama server to be ready"`, writes a 0-byte
`server.log`, and spawns no child process. Running `serve` directly works fine.
Root cause unknown; the app logs no error.

`start.ps1` works around it — starts `serve` if not listening, then brings up the
stack:

```powershell
.\start.ps1
```

Verify:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 11434   # expect 127.0.0.1
```

```bash
docker compose exec openclaw curl -s http://host.docker.internal:11435/v1/models
```

Ollama serves the OpenAI-compat routes alongside its native API, so `/v1/models`
is a convenient reachability probe. It does not imply the provider uses `/v1` —
see [Provider config](#provider-config), which uses the native adapter.

### Provider config

**The `{"ollama": {...}}` top-level block does not exist in 2026.7.1** and fails
schema validation. Providers live under `models.providers.<id>`:

```json5
{
  models: {
    mode: "merge",
    providers: {
      ollama: {
        baseUrl: "http://host.docker.internal:11435",  // 11435 = forwarder, no /v1
        apiKey: "ollama-local",
        api: "ollama",                                 // native adapter
        models: [
          { id: "qwen3.6:27b", name: "Qwen 3.6 27B", contextWindow: 32768,
            maxTokens: 8192, params: { num_ctx: 32768 },
            compat: { supportsTools: true, thinkingFormat: "qwen" },
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
          // ...one entry per model; id + name are required
        ],
      },
    },
  },
}
```

Apply with `openclaw config patch --file <path>` (run `--dry-run` first). Already
applied to this instance. Models must be declared explicitly — they are not
auto-discovered. `contextWindow` is deliberately set *below* the maximum
`/api/show` reports, sized to what fits in VRAM alongside the agent baseline —
see the sizing note below.

**`cost` requires all four keys** (`input`, `output`, `cacheRead`, `cacheWrite`).
Omitting `cacheRead`/`cacheWrite` passes `config patch --dry-run` (the config
schema treats them as optional) but fails at catalog load against the stricter
`models.json` schema: `must have required properties cacheRead, cacheWrite`.
Neither `--dry-run` nor `config get` catches it — `config get` renders a merged
view that fills defaults. Verify by reading the raw `openclaw.json` and checking
the gateway log for `model-registry` errors after a restart.

Verify end to end:

```bash
docker compose exec openclaw node openclaw.mjs agent --agent main \
  --model "ollama/qwen3.5:9b" --message "Reply with exactly the word: WORKING"
```

**Use the native `api: "ollama"` adapter with no `/v1` suffix.** An earlier
revision of this README said the opposite — that `/v1` and
`api: "openai-responses"` were "both required" — which was true only of the
first working configuration. The OpenAI-compat path produced hard failures that
were fixed by switching to the native adapter, which is also what makes
`compat.thinkingFormat` work. `apiKey` must still be a non-empty string even
though Ollama ignores it.

**Declare `num_ctx` and `contextWindow` together, and keep them equal.** Ollama's
real context is 4096 unless `num_ctx` says otherwise, whatever `contextWindow`
claims, while OpenClaw budgets against `contextWindow` — a mismatch truncates
silently. Do not shrink the window to save memory either: a full-context agent
has a ~12,785-token baseline before the user types anything, and baseline plus
compaction reserve must fit. `docs/winevents-known-issues.md` has the measured
numbers for both traps.

`ollama-provider.patch.json5` is the machine-readable copy of this block and is
kept byte-identical to the running instance; prefer it over the excerpt above.

`host.docker.internal` is not automatic on Docker Engine; the `extra_hosts` entry
in the compose file provides it.

## Agents

Agents live in `agents.list[]`; anything omitted inherits `agents.defaults`. Model
ids are `provider/model`, where the provider half indexes `models.providers`.

Current setup:

| Agent | Model | Purpose | Cost /1M in-out |
|---|---|---|---|
| `main` (default) | `ollama/qwen3.5:9b` | Everyday + orchestrator (fast) | free |
| `local` | `ollama/qwen3.5:9b` | Local worker | free |
| `local_heavy` | `ollama/qwen3.6:27b` | Heavy local, on demand (slow, CPU-spilled) | free |
| `researcher` | `ollama/qwen3.5:9b` | Research | free |
| `coding_agent` | `anthropic/claude-sonnet-5` | Small scripts supporting assistant tasks | $3/$15 ($2/$10 intro thru 2026-08-31) |
| `claude_tasks` | `anthropic/claude-haiku-4-5` | Simple assistant tasks | $1/$5 |
| — | `agents.defaults.utilityModel` = `ollama/qwen3.5:9b` | Summarization, titling, compaction | free |

Heavy coding lives in the Claude Code subscription, not here — the Anthropic
agents deliberately sit at the cheap tiers. Note `claude-haiku-4-5` has a **200K**
context and **64K** max output (every other model here is 1M/128K).

**Model IDs carry no `-0` suffix** — `claude-sonnet-5`, not `claude-sonnet-5-0`.
A wrong ID fails at first call, not at config time.

Orchestrator is `main` on **9B** — verified to drive `sessions_spawn` reliably and
fast. The 27B lives as `local_heavy` for deliberate heavy use, not as the router
(as router it made every request wait minutes; 9B does the job).

```bash
openclaw agents add <name> --non-interactive --workspace <dir> --model <id>
openclaw agent --agent local --message "..."                 # pick agent
openclaw agent --agent main --model "ollama/qwen3.5:9b" ...  # override per turn
openclaw agents bind local --bind <channel>                  # route automatically
```

With no bindings, the `default: true` agent handles everything.

### Agent Studio plugin

`plugins/agent-studio` adds a dashboard tab for colour-coding agents, editing their core persona
files, and starting agent-scoped sessions — without patching the OpenClaw image or dashboard
bundle. Deploy it with `.\deploy-agent-studio.ps1`; setup, token handling, and rollback are in
[docs/agent-studio.md](docs/agent-studio.md).

### Delegation / agent-to-agent

Two distinct mechanisms — confirmed by reading the 2026.7.1 binary:

| Config | What it does |
|---|---|
| `agents.defaults.subagents.allowAgents` | Allowlist of agent ids `main` may **spawn** via the `sessions_spawn` tool. This is how one agent hands work to another. |
| `agents.defaults.subagents.delegationMode` | `suggest` (default guidance) or `prefer` (push main to delegate anything beyond a direct reply). |
| `tools.agentToAgent` | A **policy**, not a tool. Lets session-messaging tools reach *another agent's already-running session*. Does NOT let main start an agent — that's `sessions_spawn`. |

Current: main spawns `local`/`claude`/`researcher`; `delegationMode: suggest`.

Delegation flow: main calls `sessions_spawn` with `agentId=<target>`, then
`sessions_yield` to pause while the child runs asynchronously. A single CLI
`agent` turn returns at the yield — the child's result comes back on a later
resume, not inline.

**Orchestrator = `main` on `qwen3.5:9b`** (fast). Workers: `local`/`researcher`
(9B), `local_heavy` (27B, deliberate heavy use), `claude` (hard tasks). The 27B was
tried as orchestrator but it does not fit 12 GiB VRAM (~26 GB in system RAM incl.
KV cache) — routing latency was minutes per request. 9B drives `sessions_spawn`
reliably, so it routes; the 27B is invoked on demand as `local_heavy`.

Verified working: main (9B) spawned `agent:local:subagent:*`, which produced the
expected reply.

**Session model is sticky.** A session records `modelOverride`/`model` at creation;
a `modelOverrideSource: "user"` override wins over the agent's configured model, and
changing agent config does NOT retroactively change an existing session. Symptom:
`sessions list` shows an old model after you reconfigured the agent. Clear it with
`agent --agent <id> --model auto` (the `auto` sentinel drops the override so the
session follows agent config). New sessions inherit current config with no override.

Verify a spawn actually happened — **model text output is unreliable, check ground
truth.** Spawned children do NOT appear in the orchestrator's own
`sessions.json`; they land under the *target* agent as
`agent:<target>:subagent:<uuid>`. Checking only main's store shows nothing and
misleads (this cost a wrong conclusion during setup):

```bash
# spawned sessions across ALL agents (not just main's store):
find ~/.openclaw -name sessions.json -exec cat {} \;
# tool calls in a turn:
openclaw agent --agent main --verbose on --json -m "..." | grep -A3 toolSummary
```

**Avoid editing agents by list index** (`agents.list[1].model`) — it silently
targets the wrong agent if the list is reordered. Use `config patch` keyed on `id`.

### VRAM limits (RTX 4080 Laptop, 12 GiB)

`qwen3.6:27b` is 17.4 GB at Q4_K_M — roughly 7.8 GB spills to CPU RAM and inference
drops to CPU speed (a trivial prompt exceeded 240s). It also holds VRAM until
evicted, blocking smaller models from loading. Use `qwen3.5:9b` for anything
interactive; reserve the 27B for latency-insensitive batch work.

Free VRAM explicitly:

```bash
curl http://127.0.0.1:11434/api/generate -d '{"model":"qwen3.6:27b","keep_alive":0}'
```

### Reasoning models

Qwen 3.5/3.6 emit `reasoning` before `content`. A low token limit is consumed by
the thinking and returns empty `content` with `finish_reason: "length"` — looks
like a broken integration but is not.

## Updating

**Do not run `openclaw update` inside the container.** It reports
`not-git-install` — `/app` is baked into the image, not a git checkout or npm
global install. Even if it worked, it would write to the container's writable
layer: surviving `stop`/`start` but silently lost on the next recreate, while any
config migration it performed would persist in the volume. That mismatch (new
config, old binary) is the failure below.

**The image is pinned by digest, and must stay that way.** On 2026-07-21,
`docker compose pull` moved `:latest` *backward* from 2026.7.1 to 2026.6.33. The
older binary then refused to start:

```
Refusing to run automatic gateway startup migrations because this OpenClaw
binary (2026.6.33) is older than the config last written by OpenClaw 2026.7.1.
```

That guard is correct - the config in the volume was newer than the binary.
**Never set `OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1` to work around
it**; that permits the old binary to migrate config downward, destructively.

Recovery was: re-pull the known-good digest, pin it in `docker-compose.yml`,
`up -d`.

### Why `:latest` went backward - two meanings of "latest"

Verified against both registries on 2026-07-21:

| Docker tag | Digest | npm dist-tag |
|---|---|---|
| `latest` = `main` = `2026.6.33` | `sha256:99546785…` | `extended-stable` |
| `2026.7.1` | `sha256:6a31d44…` | (on the `latest` line) |

npm dist-tags at the time: `latest: 2026.7.1-2`, `extended-stable: 2026.6.33`,
`beta: 2026.7.2-beta.3`.

**Docker's `:latest` follows the `extended-stable` channel, not npm's `latest`.**
`2026.6.33` was published *after* `2026.7.1` - it is a newer build of an older,
stabilized line, so version numbers do not sort chronologically.

The gateway's built-in updater reports npm's `latest` (`2026.7.1-2`). **That
version has no container image** - the registry has only `2026.7.1`; the `-1` and
`-2` patch releases went to npm only. The update prompt is therefore not
actionable here and can be ignored.

Moving to the `extended-stable` line would require starting from a fresh config:
`2026.6.33` is an older line than the config now in the volume, which triggers the
same refusal.

To upgrade deliberately:

1. `.\backup-config.ps1`
2. Resolve the target version's digest (do not float on a tag)
3. Update the `image:` line, `docker compose up -d`
4. Verify: gateway `200`, `secrets audit --check` clean, `agents list` intact, and
   an `agent --agent local` turn

Config migrations are written to the persistent volume, so a version bump is not
cleanly reversible by rolling the image back alone - hence step 1.

## Gotchas hit during setup

| Symptom | Cause | Fix |
|---|---|---|
| `error from registry: denied` on pull | Stale GHCR token in WSL `~/.docker/config.json`; Docker sends it instead of falling back to anonymous | `docker logout ghcr.io` |
| Config never persists, volume stays empty | Container runs as `node` (uid 1000), so config is at `/home/node/.openclaw` — mounting `/root/.openclaw` catches nothing | Mount `/home/node/.openclaw` |
| Container healthy, connection refused | `gateway.bind: loopback` | Set to `lan` (see step 3) |
| Doctor says "WSL2 needs systemd enabled" | Doctor fingerprints the host OS; you are in a container | Ignore — false positive |
| Container can't reach Ollama | Mirrored networking does not extend into Docker's bridge namespace | `ollama-fwd` socat container (see Ollama section) |
| Ollama binds `127.0.0.1` despite `OLLAMA_HOST` | Shell predates the env var; child inherited the old environment | `start.ps1` sets it explicitly |
| `openclaw models list` crashes with `Cannot read properties of undefined (reading 'input')` | Upstream bug in 2026.7.1 — `applyAnthropicSonnet5Cost` dereferences `model.cost` unguarded on a built-in catalog entry | Not fixable locally; use `models status`. Does not affect the gateway |

## Security notes

- Port is published to `127.0.0.1` only. Keep it that way — 63% of
  internet-exposed instances run with no auth configured.
- `gateway.auth.token` is a SecretRef pointing at `OPENCLAW_GATEWAY_TOKEN` in
  `.env`, not plaintext in `openclaw.json`. **The gateway will not start if that
  var is missing** — compose fails fast via `${OPENCLAW_GATEWAY_TOKEN:?...}`.
  Verify with `openclaw secrets audit --check` (expect `plaintext=0`).
  Migration was done non-interactively with:

  ```bash
  docker compose exec openclaw node openclaw.mjs config set gateway.auth.token \
    --ref-provider default --ref-source env --ref-id OPENCLAW_GATEWAY_TOKEN
  ```

- `gateway.controlUi.allowInsecureAuth` defaults to `true` after the wizard. Set
  to `false` (already done here).
- `.gitignore` covers `.env.*` as well as `.env` — a stray `.env.bak` would
  otherwise be committable.
- `ANTHROPIC_API_KEY` is injected via container env, so anything running in the
  container can read it. Use a dedicated key with a console spend limit so it can
  be revoked independently.
- Avoid ClawHub community skills — reported ~900 malicious skills, 283 leaking
  API keys.
- CVE history (from prior notes, not independently verified here): CVE-2026-25253
  "ClawBleed" RCE via `gatewayUrl`, CVE-2026-32922 token rotation race → admin RCE,
  CVE-2026-32048 sandbox escape. Running 2026.7.1, past all cited patch versions.

## Why Docker

Container-level process isolation, `NET_RAW`/`NET_ADMIN` dropped,
`no-new-privileges`, and keys injected via env rather than sitting in a file the
agent can read. A normal or npm install has none of that.

## Alternatives considered

- **Hermes Agent** — best alternative. Strong WSL2/Ollama support, lower
  supply-chain risk, no marketplace. Talks to `localhost:11434/v1` directly in
  WSL2. Needs 64K context minimum for tool use; best with Llama 4 Maverick (16GB+)
  or Mistral Small (8GB).
- **OpenAGI (aiplanethub)** — a Python dev framework, not a ready-to-run agent.
  Often conflated with a separate proactive-daemon product. Build-it-yourself.
