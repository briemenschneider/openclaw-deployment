# Agent Studio

Agent Studio is a pure OpenClaw plugin. It adds a dashboard tab for picking an agent by colour,
editing that agent's core persona files, and starting a session scoped to it. It does not modify
the OpenClaw image, the dashboard bundle, the global sidebar, or the built-in Agents page.

- Plugin id: `agent-studio`
- Source: [plugins/agent-studio](../plugins/agent-studio)
- Design: [specs/2026-08-09-agent-studio-plugin-design.md](superpowers/specs/2026-08-09-agent-studio-plugin-design.md)
- Target Gateway: OpenClaw `2026.7.1` (the digest pinned in `docker-compose.yml`)

## How the connection works

The panel runs in a sandboxed iframe with an opaque origin. It cannot read `localStorage`, reach
`window.parent`, or send an `Authorization` header without triggering a CORS preflight the sandbox
would fail. So the panel does not talk to the Gateway directly:

1. You paste the Gateway token into the panel once per panel session.
2. The panel POSTs it as `text/plain` to the plugin's own route, which is a simple request and
   needs no preflight.
3. The plugin runtime opens a loopback `GatewayClient` with that token, waits for `hello-ok`,
   drops its reference to the token, and returns a random 256-bit connection id.
4. The panel holds only that connection id. Every later request names an allowlisted operation
   (`listAgents`, `getAgentFile`, `createSession`, …) — never a raw Gateway method string.

The token is never written to storage, a URL, a log line, a response body, or plugin state. The
connection expires after 15 minutes idle, on explicit disconnect, when the Gateway closes, and when
the panel iframe is removed.

## Building from a fresh checkout

`plugins/agent-studio/dist/` is a build artifact and is not tracked. The deploy script builds
it for you; if you are running the tests directly, build first so the browser-backed panel
test has something to serve:

```powershell
npm --prefix plugins/agent-studio ci
npm --prefix plugins/agent-studio run build
npm --prefix plugins/agent-studio test
```

Without a build that one test skips rather than fails, so the suite still passes on a clean
checkout — but it is not exercising the real bundle.

## Deploying

```powershell
.\deploy-agent-studio.ps1
```

The script installs dependencies, typechecks, runs the suite, builds `dist/`, checks the build for
source maps and credential-shaped strings, verifies the packed file list, then `npm pack`s the
plugin, copies the tarball into the `openclaw` container, installs it with
`openclaw plugins install npm-pack:<tarball> --force`, enables it, restarts the Gateway, and prints
the runtime JSON. It removes the staged tarball from the container afterwards and prints the
tarball's SHA-256 so the build can be recorded below.

It never reads `.env` and never handles the Gateway token.

Options: `-SkipTests` (iterating on the deploy steps only, never for a release) and `-SkipRestart`
(install without activating).

## Pin the plugin as trusted

With `plugins.allow` unset, OpenClaw logs on every start that discovered non-bundled plugins may
auto-load, and flags `agent-studio` as untracked local code. Pin the plugins you actually trust:

```powershell
wsl -e docker exec openclaw openclaw config set plugins.allow '["signal","agent-studio"]'
```

Include every non-bundled plugin you want loaded — an allowlist that omits one disables it. Check
the current set first with `wsl -e docker exec openclaw openclaw plugins list --enabled --verbose`.

## First use

1. Open the OpenClaw dashboard and select the **Agent Studio** tab.
2. Paste the Gateway token — the value of `OPENCLAW_GATEWAY_TOKEN` in `.env` — and select
   **Connect**. Nothing is remembered; you re-enter it the next time you open the panel.
3. The left pane lists agents with the default agent selected. Use the search field to filter by
   name or id, and the ◍ action on a row to assign a colour. Colours are plugin-owned state and
   persist across restarts.
4. **Overview** shows the agent's identity. Renames are sent through `agents.update` when the
   Gateway advertises it; otherwise the pane says so and points at the built-in Agents page.
5. **Persona** loads the file list when you open it and each file when you select its tab.
   Files that do not exist yet offer **Create file**.
6. **New session** starts a session for the selected agent. **Advanced** adds label, model
   override, initial task, and a worktree toggle. The created session key is shown with a copy
   action; open the session itself from OpenClaw's Sessions list.

## Editing safely

Each persona editor records the server copy it loaded. Saving re-reads the current server value
first and compares it to that recording. If another writer changed the file in the meantime, the
panel shows both versions and requires an explicit choice — overwrite with yours, or take the
server's. It never silently overwrites a concurrent edit.

If the connection expires while you are editing, the editor locks but keeps your text. Reconnect
and the draft is still there; closing the panel discards it.

## Updating

Re-run `.\deploy-agent-studio.ps1`. `--force` replaces the installed copy, and the restart picks up
the new runtime. Record the new SHA-256 below.

## Disabling and uninstalling

```powershell
wsl -e docker exec openclaw openclaw plugins disable agent-studio
```

```powershell
wsl -e docker exec openclaw openclaw plugins uninstall agent-studio
```

Disabling removes the tab and stops the plugin's HTTP route; the Gateway is unaffected. Agent
colours live in the plugin's own state directory and survive a disable, but not an uninstall that
clears plugin state.

## Rollback

1. `wsl -e docker exec openclaw openclaw plugins disable agent-studio` — immediate, and enough to
   remove the surface if the panel misbehaves.
2. To return to a previous build, check out the commit that produced it, then re-run
   `.\deploy-agent-studio.ps1`; the install is by tarball, so the checked-out source is exactly
   what lands in the container.
3. `wsl -e docker exec openclaw openclaw plugins uninstall agent-studio` removes it entirely. The
   OpenClaw image, dashboard bundle, and built-in Agents page were never modified, so there is
   nothing else to revert.

## Verified builds

| Date | OpenClaw version / digest | Package SHA-256 |
| --- | --- | --- |
| 2026-08-09 | `2026.7.1` — `sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c` | `a5f6b7e925c760d016fde0575f8f1152ede82ecbe8fcd1811cf9d5c4c44f15cf` |

> Supersedes `2a503a23…`, which shipped a defect where a persona save issued while
> the operator switched agents could write one agent's draft into another agent's
> file. Do not run that build.

What that build was verified to do, against the live container:

- installs from `npm-pack:` and reports `status: loaded`, `activated: true`, one HTTP route, no
  diagnostics;
- serves the panel with `sandbox allow-scripts`, `default-src 'none'`, `Access-Control-Allow-Origin:
  null`, and `Cache-Control: no-store`, and serves hashed assets `immutable`;
- rejects an API POST from a normal web origin (403), a non-simple content type (403), `GET` on the
  API route (405), and a percent-encoded path traversal (400) — no file outside the panel is served;
- leaves no token value, connection id, or credential-shaped string in the Gateway log.

Still to confirm by hand — every one of these needs the Gateway token typed into the browser, which
the operator must do:

- wrong token rejected with a generic error, correct token connects, explicit disconnect works;
- 15-minute idle expiry and Gateway restart both drop the panel to the token screen;
- colours assigned to two agents survive a Gateway restart;
- SOUL and USER edits on a disposable test agent save and reload, and an induced concurrent edit
  produces the conflict panel;
- an immediate session and an advanced session each appear under the right agent in the Sessions
  list;
- desktop and narrow-layout screenshots, and a keyboard-only pass.
