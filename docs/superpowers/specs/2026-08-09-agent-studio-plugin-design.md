# Agent Studio Pure Plugin — Design

**Date:** 2026-08-09  
**Status:** Approved for implementation planning  
**Target:** OpenClaw `v2026.7.1`, deployed from `C:\Users\briem\Documents\OpenClaw`

## Problem

OpenClaw's built-in Agents page exposes agent configuration, but agent selection is a compact
dropdown and the global sidebar remains session-oriented. Managing several agents therefore
requires too much context switching, gives agents no stable visual identity, and separates
persona editing from session creation.

Agent Studio will provide one focused dashboard surface where an operator can:

- search and select agents from a color-coded list;
- assign a persistent color to each agent;
- edit the agent's model-facing core files, including AGENTS, SOUL, USER, IDENTITY, TOOLS,
  HEARTBEAT, BOOTSTRAP, and MEMORY when present;
- inspect and update the agent's normal configuration fields;
- create a session for the selected agent immediately, with an optional advanced form.

## Chosen approach

Agent Studio will be a pure external OpenClaw plugin. It will not patch, fork, or replace any
OpenClaw source file.

The plugin registers a `surface: "tab"` Control UI descriptor named **Agent Studio**, grouped
with agent-related navigation. OpenClaw renders the plugin's dashboard inside its standard
sandboxed iframe. The approved two-pane mock-up is reproduced inside that frame: Agent Studio
has its own agent directory on the left and agent details/editor on the right.

This decision deliberately accepts two limitations of the public plugin contract:

1. OpenClaw's global sidebar and built-in Agents page remain unchanged.
2. The sandboxed frame cannot navigate the parent dashboard. A newly created session appears in
   OpenClaw's normal Sessions list, but Agent Studio cannot automatically open it in the parent.

No hidden DOM injection, monkey-patching, or private OpenClaw imports may be used to work around
those limits.

## User experience

### Entry and authentication

The enabled plugin contributes **Agent Studio** under the dashboard's agent group. Opening it
shows a small connection screen before any agent data is requested:

- one password-style input labelled **Gateway token**;
- **Connect** as the primary action;
- a short explanation that the token is retained only in memory for this panel session;
- generic authentication errors that do not disclose whether a token was close to valid.

The token is never placed in a URL, DOM attribute, log message, config file, localStorage,
sessionStorage, IndexedDB, or plugin state file. Closing/reloading the panel requires entering it
again. A **Disconnect** action destroys the backend connection and clears panel state.

### Agent directory

After authentication, the left pane contains:

- title and agent count;
- search by agent name or id;
- one row per agent with color swatch, name, id, model summary, and selected state;
- an overflow action for changing the color;
- deterministic ordering: default agent first, then case-insensitive name/id;
- empty, loading, disconnected, and error states.

Selecting an agent updates the right pane without leaving the plugin tab. The selected agent id
is held in memory only; it is not written back into OpenClaw's global dashboard state.

### Agent editor

The right pane keeps the approved header and tab organization:

- **Overview:** identity, workspace, model, and other supported agent settings;
- **Persona:** AGENTS, SOUL, USER, IDENTITY, TOOLS, HEARTBEAT, BOOTSTRAP, and MEMORY file tabs;
- **Tools, Skills, Channels, Cron:** read or edit only where public Gateway methods already
  provide the necessary operation; unsupported controls link the operator to the built-in page
  instead of reimplementing private behavior.

Persona files load lazily. Each editor tracks the original content. Saving first reloads the
current server value; if it differs from the original, Agent Studio presents a conflict instead
of overwriting a concurrent edit. Missing optional files show a **Create file** action. Save
success, validation failures, connection loss, and conflicts are all displayed inline.

### Session creation

**New session** creates a session immediately for the selected agent using OpenClaw's
`sessions.create` method. The plugin displays the returned session key, copies it on request, and
explains that it is now available in OpenClaw's Sessions list.

An adjacent **Advanced** action opens a dialog with only fields supported by the pinned Gateway
schema:

- label;
- model override;
- initial task/message;
- worktree toggle.

The advanced form validates locally and remains open on server errors. It never silently falls
back to a different agent or model.

## Architecture

```text
OpenClaw dashboard
  Agent Studio plugin tab
    sandboxed iframe (scripts allowed, opaque origin)
      panel application
        POST text/plain to plugin-managed route
          short-lived panel connection id
            public GatewayClient on 127.0.0.1:18789
              agents.*, agents.files.*, models.list, sessions.create

Plugin runtime
  static panel assets
  panel-session broker
  allowlisted Gateway RPC adapter
  agent-color state.json
```

### Package

The plugin package id is `agent-studio`. It is a TypeScript ESM package built to JavaScript and
installed from an `npm pack` tarball. Runtime entries point to `dist/index.js`; the iframe assets
are emitted under `dist/ui/` and included in the package.

The manifest declares startup activation and a strict empty/small config schema. Agent colors
are runtime state, not configuration, so changing a color does not reload the Gateway.

### Dashboard contribution

On full registration, the plugin calls `api.session.controls.registerControlUiDescriptor` with:

- `surface: "tab"`;
- `id: "agent-studio"`;
- `label: "Agent Studio"`;
- `group: "agent"`;
- `requiredScopes: ["operator.write"]`;
- `path: "/plugins/agent-studio/"`.

One prefix HTTP route at `/plugins/agent-studio/` uses `auth: "plugin"`. It serves immutable
static assets on GET and the panel broker at `POST /plugins/agent-studio/api`. Because both are
plugin-auth routes, they do not overlap routes with different OpenClaw auth policies.

### Token broker

The default script sandbox gives the iframe an opaque browser origin. Sending an Authorization
header to a Gateway-auth route would trigger a CORS preflight that OpenClaw rejects before the
plugin handler can respond. Agent Studio therefore uses a plugin-managed broker:

1. The panel sends a simple `text/plain` POST containing `{ action: "connect", token }`.
2. The plugin creates the public `GatewayClient` from
   `openclaw/plugin-sdk/gateway-runtime`, connecting only to the configured loopback Gateway
   port with the supplied token and `operator.read`/`operator.write` scopes.
3. After `hello-ok`, the plugin clears its token string reference and returns a random 256-bit
   panel connection id.
4. Later requests contain only that connection id, action, and payload. The server maps it to the
   live GatewayClient.
5. Connections expire after 15 minutes of inactivity, are capped globally and per source IP,
   and are closed on explicit disconnect, Gateway close, plugin reload, or shutdown.

Broker responses allow only `Origin: null`, set `Cache-Control: no-store`, and never echo the
token. Requests use `Content-Type: text/plain` to remain a CORS-simple request and are capped at
64 KiB. Connection attempts are rate-limited. Logs contain action names and opaque connection
ids only, never request bodies or credentials.

The broker exposes an explicit operation allowlist. Arbitrary Gateway method names are never
accepted from the browser.

### Gateway operation allowlist

The first implementation may dispatch only:

- `agents.list`;
- `agents.get`/`agents.update` where advertised by the pinned Gateway;
- `agents.files.list`, `agents.files.get`, `agents.files.set`;
- `models.list`;
- `sessions.create`.

Startup and integration tests compare this list with the Gateway's advertised method set and
disable unsupported UI controls. No config.*, exec.*, node.*, cron mutation, deletion, shell, or
arbitrary method proxy is exposed.

### Agent colors

Colors are plugin-owned presentation state. They are stored as a versioned JSON document at a
plugin-namespaced path below `api.runtime.state.resolveStateDir(process.env)`, for example:

```json
{
  "version": 1,
  "agents": {
    "main": "#ef5b5b"
  }
}
```

Only six-digit hexadecimal colors are accepted. Writes are serialized and atomic
(temporary file, fsync where available, rename). Unknown/missing agent ids are harmless and are
pruned only through an explicit maintenance path, never during a read.

## Error handling

- Invalid/expired token: return an authentication error and remain on the connection screen.
- Expired panel connection: clear sensitive UI data and request the token again.
- Gateway unavailable: preserve unsaved editor text locally in memory and offer retry.
- Concurrent file edit: show both versions and require reload or explicit replacement.
- Unsupported Gateway method: disable the control and identify the required OpenClaw version.
- Partial agent data: render available fields; do not discard the whole page.
- Session creation uncertainty: re-query sessions before retrying to avoid accidental duplicate
  creation when a response was lost.

## Accessibility and visual behavior

The panel mirrors the approved dark OpenClaw visual language without importing private dashboard
CSS. All actions are keyboard reachable, focus is trapped in dialogs, color is never the only
selected-state indicator, contrast meets WCAG AA, and narrow layouts collapse the agent directory
into a drawer. Loading motion respects `prefers-reduced-motion`.

## Testing and acceptance

Automated coverage includes:

- manifest/package validation and runtime registration;
- token redaction, connection expiry, rate limiting, request-size limits, and exact CORS headers;
- the opaque-origin simple-request path with no preflight;
- Gateway operation allowlisting and scope requests;
- color validation, atomic persistence, and corrupt-state recovery;
- persona lazy loading, save conflicts, and missing-file creation;
- immediate and advanced `sessions.create` payloads;
- component behavior, keyboard navigation, and responsive states.

Package verification uses `npm pack`, installs the tarball into the pinned OpenClaw container,
and confirms `openclaw plugins inspect agent-studio --runtime --json`. Manual acceptance then
checks the real dashboard tab, token prompt, agent switching, file save/reload, color persistence
across Gateway restart, session appearance in the normal Sessions list, and zero core source
changes.

## Non-goals

- Replacing or modifying OpenClaw's global sidebar or built-in Agents route.
- Automatically navigating the parent dashboard after session creation.
- Creating/deleting agents in the first release.
- Editing arbitrary workspace files.
- Persisting the Gateway token or deriving it from OpenClaw config.
- Exposing a generic HTTP-to-Gateway RPC proxy.
- Publishing to npm or ClawHub during the initial local deployment.

