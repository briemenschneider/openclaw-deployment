# Agent Template Import Design

**Goal:** Let an operator scaffold a new agent's core files by copying them from another
agent, without any risk of destroying content the target agent already has.

**Surface:** Agent Studio panel only. No new Gateway operations, no new broker code, no
plugin state, and no configuration.

**Spec for:** `plugins/agent-studio`, extending the persona surface built in
[2026-08-09-agent-studio-plugin-design.md](2026-08-09-agent-studio-plugin-design.md).

## Problem

A new agent starts with eight empty or stub core files. Filling them in means retyping the
same profile, tone, and tool notes that an existing agent already carries. OpenClaw's own
bootstrap templates do not help: they resolve from the image's package root and apply only
when the workspace is first scaffolded, so they cannot be edited by the operator or applied
to an agent that already exists.

## What this is

An **Import from agent…** action in the Persona pane. The operator picks a source agent;
Agent Studio copies each of the eight core files into the selected agent, writing only the
files the target is missing or has blank.

A "template" is therefore a convention, not a concept in the code: make an agent, never run
it, edit its files with the persona editor that already exists, and import from it. The same
action also serves the plainer case of copying a good persona from a working agent to a new
one.

## Decisions

| Decision | Rationale |
|---|---|
| The template is an ordinary agent | Reuses the persona editor, `agents.files.get/set`, and whatever already backs up agents. No new storage, editor, or broker operation. |
| Any agent can be the source | A picker costs one click and removes a config key, a missing-agent edge case, and directory-filtering rules. Strictly more capable than a single designated template. |
| Import only fills blanks | Import can never destroy work, so it needs no confirmation dialog, no undo, and no diff surface. |
| All eight files, no selection | The blank rule already makes the per-file decision; a checkbox list would be UI for a choice the operator rarely needs. |

**Accepted trade-off:** re-importing an edited template into an agent that is already set up
does nothing, because none of its files are blank. Import is a scaffolding tool, not a sync
tool. Pushing later template changes into existing agents would need a diff-and-choose
surface, which is deliberately out of scope.

## Files

| File | Responsibility |
|---|---|
| `src/ui/import-state.ts` | Import controller: the copy algorithm, per-file results, and lifecycle |
| `src/ui/agent-import.ts` | `<agent-import>`: source picker, run button, result list |
| `src/ui/agent-persona.ts` | Hosts the import action in the pane header |
| `src/ui/persona-state.ts` | Gains `invalidate(agentId)` so imported content is not masked by the editor cache |
| `src/ui/agent-studio-app.ts` | Wires the controller to the component and to the persona store |
| `test/ui/import.test.ts` | Controller, component, and app-integration tests |

## Controller

```ts
createImportController({ api, connectionId, features }): ImportController
```

State:

```ts
type ImportFileOutcome = "written" | "skipped" | "empty-in-source" | "failed";

type ImportState = {
  status: "idle" | "running" | "done" | "error";
  targetAgentId?: string;
  sourceAgentId?: string;
  results: { name: string; outcome: ImportFileOutcome }[];
  errorText?: string;
};
```

`run(targetAgentId, sourceAgentId)` walks the eight core files in `PERSONA_FILES` order. For
each file:

1. Read the source. Missing, or content whose `trim()` is empty → `empty-in-source`; nothing
   is written. This covers OpenClaw's bootstrapped stubs, which exist but hold only headings.
2. Read the target. Content whose `trim()` is non-empty → `skipped`.
3. Otherwise write the source content to the target → `written`.

Available only when the Gateway advertises both `getAgentFile` and `setAgentFile`; otherwise
the component renders an unavailable notice and the action is absent.

## Correctness under agent switching

The panel's earlier defects came from attributing an async result to whichever agent was
selected when it landed. This controller follows the corrected rule:

- `run` captures `targetAgentId` and `sourceAgentId` at entry and addresses every read and
  write to the captured ids. Switching agents mid-run cannot redirect a write.
- A run that is still in flight when the operator switches agents completes against its
  original target. The component renders results only while `state.targetAgentId` matches the
  agent on screen, so one agent's results never appear under another.
- One run at a time: `run` returns immediately when `status === "running"`.

## Error handling

- A per-file read or write failure records `failed` for that file and continues; the run ends
  with `status: "done"` and a summary that names the failures.
- `CONNECTION_EXPIRED` aborts the whole run with `status: "error"`, since every remaining
  request would fail the same way. The panel's existing expiry handling takes over.
- Error text is fixed UI copy. Gateway messages are never surfaced.
- After any run that wrote at least one file, the app calls `persona.invalidate(target)` so
  the editor re-reads the file it now shows.

`invalidate(agentId)` drops that agent's cached editors **except any with unsaved changes**.
Import only writes files that were blank, and a dirty editor holds text the operator typed,
so discarding it would throw away work that import itself was never allowed to touch. The
selected file tab does not change.

## Interface

`<agent-import>` is presentational: it takes `state`, the target agent id, and the candidate
source agents, and emits `import-run` with the chosen source id. It holds only the picker's
current selection. The source list excludes the target agent.

The action sits in the Persona pane header, next to the file tabs — these are the files it
writes, and it is where the operator is already working when an agent looks empty.

## Testing

Controller:

- writes a file the target is missing;
- writes a file whose target content is whitespace only;
- skips a file with real content, leaving the target byte-identical;
- writes nothing for a file that is blank or missing in the source;
- a failure on one file does not prevent the remaining files from being processed;
- `CONNECTION_EXPIRED` aborts the run;
- a second `run` while one is in flight is ignored;
- every write is addressed to the target captured at entry, even when the selection changes
  mid-run.

Component: the picker excludes the target; results render per file; results for another
target are not shown; the action is absent when the Gateway lacks the methods.

Integration: importing into an agent, then opening the Persona tab, shows the imported
content rather than a stale cached editor; an editor with unsaved changes keeps its draft
across an import.

The test fixture is the agent-aware `fileServer` from `test/ui/persona.test.ts`, keyed by
`(agentId, name)` — a fixture keyed by filename alone cannot tell a correctly addressed write
from a misaddressed one.

## Out of scope

Diff or preview before writing; re-sync and drift detection when a template later changes;
template versioning; an overwrite mode; per-file selection; hiding template agents from the
directory; any configuration key. Agent creation stays with OpenClaw's CLI — `agents.create`
is not in the broker's allowlist and this design does not add it.

## Release notes

This is a panel-only change: `dist/index.js` is unaffected, but the panel bundle changes, so
the plugin still has to be rebuilt, packed, and redeployed with `deploy-agent-studio.ps1`.
