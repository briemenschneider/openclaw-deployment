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
| _pending_ | _pending end-to-end acceptance (plan Task 12)_ | _pending_ |

The plugin has been built, typechecked, and tested against the pinned `2026.7.1` SDK, but the
end-to-end acceptance run against the live container — real tab, wrong/right token, idle expiry,
Gateway restart, colour persistence, a conflict, and both session paths — has not been performed
yet. Fill this table in from that run.
