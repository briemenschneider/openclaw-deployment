# Agent Studio Pure Plugin Implementation Plan

> **For agentic workers:** Use `superpowers:test-driven-development` for each task and
> `superpowers:verification-before-completion` before claiming the plugin is ready.

**Goal:** Add a pure OpenClaw dashboard plugin for color-coded agent selection, full persona
editing, and agent-scoped session creation without modifying OpenClaw core.

**Architecture:** An external TypeScript plugin contributes an Agent Studio dashboard tab and
serves a sandboxed panel. A plugin-managed broker accepts a Gateway token once, opens a public
loopback `GatewayClient`, and returns a short-lived panel connection id. The panel can invoke only
an explicit agent/session RPC allowlist. Colors live in atomic plugin-owned state.

**Target:** OpenClaw `v2026.7.1`; Node 24 ESM; TypeScript; Lit; Vite; Vitest.

**Spec:** `docs/superpowers/specs/2026-08-09-agent-studio-plugin-design.md`

## Global constraints

- No edits to the OpenClaw image, UI bundle, global sidebar, or built-in Agents page.
- Import only documented `openclaw/plugin-sdk/<subpath>` contracts.
- Never persist, log, echo, or place the Gateway token in a URL.
- Browser requests use `text/plain`, `Origin: null`, and the plugin-managed route; do not enable
  `gateway.controlUi.embedSandbox="trusted"`.
- Never accept an arbitrary Gateway method name from the browser.
- Keep the existing user edit to `ollama-provider.patch.json5` untouched.
- Build and install the final package from `npm pack`, not from raw TypeScript sources.

## Planned file structure

| File | Responsibility |
|---|---|
| `plugins/agent-studio/package.json` | Package metadata, build/test scripts, OpenClaw compatibility |
| `plugins/agent-studio/openclaw.plugin.json` | Plugin manifest and activation contract |
| `plugins/agent-studio/tsconfig.json` | Strict TypeScript configuration |
| `plugins/agent-studio/vite.config.ts` | Panel bundle and test configuration |
| `plugins/agent-studio/src/index.ts` | Plugin registration, tab descriptor, HTTP route |
| `plugins/agent-studio/src/http-handler.ts` | Static assets, simple-request API, response hardening |
| `plugins/agent-studio/src/panel-sessions.ts` | Token-to-GatewayClient bootstrap and connection lifecycle |
| `plugins/agent-studio/src/gateway-operations.ts` | Typed, allowlisted Gateway operations |
| `plugins/agent-studio/src/color-store.ts` | Versioned atomic color persistence |
| `plugins/agent-studio/src/protocol.ts` | Browser/server request and response validation |
| `plugins/agent-studio/src/ui/*` | Lit panel, views, state, CSS, API client |
| `plugins/agent-studio/test/*` | Runtime, security, service, and UI tests |
| `deploy-agent-studio.ps1` | Build, pack, copy, install, enable, and inspect in the container |
| `docs/agent-studio.md` | Operator setup, token behavior, usage, update, rollback |

## Task 0: Scaffold the test harness

**Files:**

- Create: `plugins/agent-studio/package.json`
- Create: `plugins/agent-studio/tsconfig.json`
- Create: `plugins/agent-studio/vite.config.ts`

- [ ] Create only the package and test/build configuration needed to run Task 1; do not create
  any plugin runtime or UI production code.
- [ ] Pin peer compatibility to OpenClaw 2026.7.x and configure strict TypeScript, Vitest, and the
  future Vite panel build.
- [ ] Install the locked dependencies and verify Vitest starts successfully with no test files.
- [ ] Commit the generated lockfile with the scaffold.

Run:

```powershell
npm --prefix plugins/agent-studio install
npm --prefix plugins/agent-studio test -- --run
```

Expected: Vitest starts successfully and exits because no test files exist. Task 1 supplies the
first failing behavioral test before any production module is written.

## Task 1: Prove the pure-plugin transport

**Files:**

- Create: `plugins/agent-studio/test/transport-spike.test.ts`
- Create: `plugins/agent-studio/test/fixtures/fake-gateway.ts`

- [ ] Write a failing integration test that serves a document in an iframe-equivalent opaque
  origin and sends a `text/plain` POST with `Origin: null` without an OPTIONS request.
- [ ] Prove that a gateway-auth route with an Authorization header would preflight and document
  why that path is rejected.
- [ ] Instantiate `GatewayClient` from `openclaw/plugin-sdk/gateway-runtime` against the fake
  Gateway using a supplied token and requested `operator.read`/`operator.write` scopes.
- [ ] Verify `hello-ok`, one request/response, invalid-token failure, and clean shutdown.
- [ ] If any proof fails against the pinned SDK, stop here and revise the design; do not build a
  private OpenClaw import or enable trusted iframe mode as a workaround.

Run:

```powershell
npm --prefix plugins/agent-studio test -- transport-spike
```

Expected: all transport assertions pass and the captured browser request list contains no
preflight for the chosen protocol.

## Task 2: Scaffold and register the plugin

**Files:** package/manifest/config files, `src/index.ts`, `test/registration.test.ts`.

- [ ] Create a package with runtime entry `./dist/index.js`, peer compatibility pinned to
  OpenClaw 2026.7.x, and packaged files limited to `dist`, manifest, README, and license.
- [ ] Add a strict manifest for plugin id `agent-studio`, startup activation, and no model tools.
- [ ] Write a failing registration test for exactly one Control UI descriptor and one HTTP route.
- [ ] Register the tab as `surface: "tab"`, group `agent`, required scope `operator.write`, path
  `/plugins/agent-studio/`.
- [ ] Register a single prefix HTTP route with explicit `auth: "plugin"`.
- [ ] Verify discovery/CLI metadata modes do not create live clients or timers.

Run:

```powershell
npm --prefix plugins/agent-studio test -- registration
npm --prefix plugins/agent-studio run typecheck
```

## Task 3: Build the token broker and connection lifecycle

**Files:** `src/panel-sessions.ts`, `src/protocol.ts`, corresponding tests.

- [ ] Define closed request unions for `connect`, `disconnect`, and authenticated operations.
- [ ] Reject unknown keys, malformed ids, oversized payloads, and unsupported actions.
- [ ] Write failing tests proving token strings never enter responses, errors, snapshots, or logs.
- [ ] On connect, open the public loopback `GatewayClient`, wait for `hello-ok`, clear the token
  reference, and return a cryptographically random 256-bit connection id.
- [ ] Add a 15-minute sliding idle expiry, explicit disconnect, Gateway-close cleanup, plugin
  shutdown cleanup, and global/per-IP connection caps.
- [ ] Add a connection-attempt limiter and generic authentication errors.
- [ ] Use fake timers to prove expiry and cleanup leave no live socket/timer handles.

Run:

```powershell
npm --prefix plugins/agent-studio test -- panel-sessions protocol
```

## Task 4: Serve the panel and hardened API

**Files:** `src/http-handler.ts`, `test/http-handler.test.ts`, minimal `src/ui/index.html`.

- [ ] Test GET handling, safe asset-path normalization, MIME types, CSP, no directory traversal,
  and immutable caching for hashed assets.
- [ ] Test POST only at `/plugins/agent-studio/api`, `Content-Type: text/plain`, body limit 64 KiB,
  exact `Origin: null`, `Access-Control-Allow-Origin: null`, and `Cache-Control: no-store`.
- [ ] Reject normal web origins, missing origin on browser operations, non-simple content types,
  and every unsupported method.
- [ ] Route connect/disconnect/action messages to the broker without logging bodies.
- [ ] Confirm the UI remains functional under OpenClaw's `scripts` sandbox and does not require
  same-origin storage or parent-window access.

Run:

```powershell
npm --prefix plugins/agent-studio test -- http-handler
```

## Task 5: Implement the Gateway operation allowlist

**Files:** `src/gateway-operations.ts`, `test/gateway-operations.test.ts`.

- [ ] Define browser operation names independent of Gateway method strings.
- [ ] Map only agent listing/details, agent file list/get/set, model list, session listing, and
  session creation.
- [ ] Validate every operation payload before calling `client.request`.
- [ ] Normalize Gateway errors into stable UI error codes without leaking credentials or server
  internals.
- [ ] Prove arbitrary method strings and reserved namespaces cannot reach GatewayClient.
- [ ] On connect, cache advertised methods and return feature flags so unsupported controls are
  disabled rather than failing late.

Run:

```powershell
npm --prefix plugins/agent-studio test -- gateway-operations
```

## Task 6: Add persistent agent colors

**Files:** `src/color-store.ts`, `test/color-store.test.ts`.

- [ ] Resolve a plugin-namespaced directory from `api.runtime.state.resolveStateDir`.
- [ ] Test default state, six-digit hex normalization, rejected values, concurrent writes, corrupt
  JSON recovery, and preservation of unknown agent ids.
- [ ] Implement serialized atomic writes with a temporary file and rename.
- [ ] Add `colors.list` and `colors.set` broker operations; never expose arbitrary filesystem
  paths.
- [ ] Verify colors survive a plugin/Gateway restart in an integration fixture.

Run:

```powershell
npm --prefix plugins/agent-studio test -- color-store
```

## Task 7: Build the panel shell and token screen

**Files:** `src/ui/main.ts`, `agent-studio-app.ts`, `api-client.ts`, `styles.css`, UI tests.

- [ ] Write UI tests for the disconnected screen, masked token field, submit states, generic
  errors, Enter-to-connect, and explicit disconnect.
- [ ] Keep the token only in a local function scope until the connect request settles, then clear
  the input and reference.
- [ ] Hold only the opaque connection id in component memory.
- [ ] Build the approved dark two-pane shell with responsive drawer behavior and OpenClaw-like
  spacing/colors defined locally.
- [ ] Add accessible focus order, visible focus, status announcements, and reduced-motion support.

Run:

```powershell
npm --prefix plugins/agent-studio test -- ui/auth ui/shell
```

## Task 8: Implement agent selection and color coding

**Files:** `src/ui/agent-directory.ts`, `src/ui/agent-state.ts`, tests.

- [ ] Test loading, empty, error, selection, search by name/id, deterministic sorting, and keyboard
  navigation.
- [ ] Load agent summaries and colors after connection; select the default agent first.
- [ ] Render color plus a non-color selected indicator.
- [ ] Add an accessible color picker with a constrained palette and validated custom hex input.
- [ ] Apply optimistic color changes and roll back on persistence failure.

Run:

```powershell
npm --prefix plugins/agent-studio test -- ui/agent-directory
```

## Task 9: Implement overview and persona editing

**Files:** overview/persona/editor components and tests.

- [ ] Test lazy file loading, tabs for all supported core files, missing-file creation, dirty-state
  warnings, cancel/reload, save success, validation error, and conflict handling.
- [ ] Load only the selected file; cache it per agent for the panel session.
- [ ] Before save, reload the server copy and compare it to the recorded original.
- [ ] On conflict, show current server and local versions and require an explicit choice.
- [ ] Disable editing when the connection expires while preserving unsaved text in memory until
  reconnect or panel close.
- [ ] Implement only Overview controls backed by advertised public methods; mark the rest read-only
  or link to the built-in page.

Run:

```powershell
npm --prefix plugins/agent-studio test -- ui/persona ui/overview
```

## Task 10: Implement immediate and advanced session creation

**Files:** `src/ui/session-create.ts`, `test/ui/session-create.test.ts`.

- [ ] Test that the primary action always sends the selected `agentId` and no stale agent id.
- [ ] Test the advanced fields: label, model, task/message, and worktree.
- [ ] Validate fields, prevent double submission, and keep the dialog open on failure.
- [ ] After success, display the session key, provide copy-to-clipboard, and instruct the user to
  select it from OpenClaw's Sessions list.
- [ ] When the response is lost, query the visible sessions before offering retry to reduce
  duplicates.
- [ ] Do not attempt `window.parent` navigation, DOM injection, or nested dashboard rendering.

Run:

```powershell
npm --prefix plugins/agent-studio test -- ui/session-create
```

## Task 11: Package and deploy to the pinned container

**Files:** `deploy-agent-studio.ps1`, `docs/agent-studio.md`, README update.

- [ ] Build UI and runtime into `dist/`; inspect the output for accidental source maps or secrets.
- [ ] Run `npm pack --dry-run`, assert the manifest and UI assets are present, then create the
  tarball.
- [ ] Make `deploy-agent-studio.ps1` copy the tarball into the `openclaw` container, run
  `openclaw plugins install npm-pack:<tarball> --force`, enable `agent-studio`, restart the Gateway
  through the deployment's established mechanism, and inspect runtime JSON.
- [ ] Document first use, token handling, updating, disabling, uninstalling, and rollback.
- [ ] Ensure the deploy script never prints `.env` or the Gateway token.

Verification commands:

```powershell
npm --prefix plugins/agent-studio ci
npm --prefix plugins/agent-studio run typecheck
npm --prefix plugins/agent-studio test
npm --prefix plugins/agent-studio run build
npm --prefix plugins/agent-studio pack -- --dry-run
docker compose exec -T openclaw openclaw plugins inspect agent-studio --runtime --json
```

## Task 12: End-to-end acceptance and release gate

- [ ] Run the full suite from a clean install.
- [ ] Confirm the repository diff contains no OpenClaw core source or generated dashboard bundle.
- [ ] Open the real Agent Studio tab in the in-app browser and capture desktop and narrow-layout
  screenshots.
- [ ] Verify wrong token, correct token, disconnect, idle expiry, and Gateway restart.
- [ ] Select at least two agents, assign colors, restart, and confirm persistence.
- [ ] Edit and reload SOUL and USER on a disposable test agent; induce and verify one conflict.
- [ ] Create one immediate and one advanced session and confirm each appears under the correct
  agent in OpenClaw's Sessions list.
- [ ] Run keyboard-only and contrast checks.
- [ ] Review logs and packaged files for the literal test token and other credential patterns.
- [ ] Record the tested OpenClaw digest/version and package integrity hash in
  `docs/agent-studio.md`.

Release is blocked if any of these are true:

- the token is persisted or logged;
- a browser-supplied Gateway method string is dispatched;
- trusted iframe mode is required;
- the parent dashboard is patched or manipulated;
- persona save can silently overwrite a concurrent change;
- a session is created for a different agent than the visible selection.
