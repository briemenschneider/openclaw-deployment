# Agent Template Import Design

**Goal:** Let an operator scaffold a new agent's core files by copying them from another
agent, without ever overwriting content the target agent already has.

**Surface:** Agent Studio panel only. No new Gateway operations, no new broker code, no
plugin state, and no configuration.

**Spec for:** `plugins/agent-studio`, extending the persona surface built in
[2026-08-09-agent-studio-plugin-design.md](2026-08-09-agent-studio-plugin-design.md).

## Problem

A new agent starts with seven core files that OpenClaw has bootstrapped to stubs — a heading
and some empty labels. Filling them in means retyping the same profile, tone, and tool notes
that an existing agent already carries. OpenClaw's own bootstrap templates do not help: they
resolve from the image's package root and apply only when the workspace is first scaffolded,
so they cannot be edited by the operator or applied to an agent that already exists.

## What this is

An **Import from agent…** action in the Persona pane. The operator picks a source agent;
Agent Studio copies each core file into the selected agent, writing only the files the target
has not filled in.

A "template" is therefore a convention, not a concept in the code: make an agent, never run
it, edit its files with the persona editor that already exists, and import from it. The same
action also serves the plainer case of copying a good persona from a working agent to a new
one.

## Decisions

| Decision | Rationale |
|---|---|
| The template is an ordinary agent | Reuses the persona editor, `agents.files.get/set`, and whatever already backs up agents. No new storage, editor, or broker operation. |
| Any agent can be the source | A picker costs one click and removes a config key, a missing-agent edge case, and directory-filtering rules. |
| Import only fills files with nothing in them | Import cannot destroy authored text, so it needs no confirmation dialog and no undo. |
| All copied files, no selection | The fillable rule already makes the per-file decision; a checkbox list would be UI for a choice the operator rarely needs. |
| `MEMORY.md` is not copied | It holds durable preferences an agent accumulated, not persona its author wrote. Cloning it would give a new agent memories it never formed. |

## Which files are copied

The seven authored core files, in this order:

`AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`

`MEMORY.md` is excluded. `PERSONA_FILES` keeps all eight for the editor; the import set is a
separate constant so the exclusion is visible rather than implied.

## When a file counts as fillable

`trim()`-empty is not sufficient. OpenClaw bootstraps files to stubs like:

```markdown
# USER.md - User Profile

- Name:
- Preferred address:
- Notes:
```

That is not blank, so a blank-only rule would skip all seven files on precisely the
freshly-created agents this feature exists for, and import would silently do nothing.

A file is **fillable** when it is missing, or when removing all of the following leaves
nothing behind:

- blank lines;
- ATX heading lines (`^\s{0,3}#{1,6}\s`);
- HTML comments;
- labelled list items with no value — `^\s*[-*]\s*[^:\n]+:\s*$`.

Anything else counts as content and the file is skipped. The rule is deliberately
conservative: when it cannot tell, it sees content and skips. `- Name: Brice` survives the
filter and is content; `- Name:` does not and is a stub.

The same rule applies to the **source**: a source file that is missing or fillable has
nothing worth copying, and is reported `empty-in-source`.

**A file with unsaved changes in the open editor is never fillable.** A draft is content even
though the server has not seen it. This also avoids a phantom conflict: import writes through
`setAgentFile` directly, bypassing the store's read-then-write protocol, so writing under a
draft would leave the editor's recorded original stale and pop the conflict dialog on the
operator's next Save with no explanation.

## Files

| File | Responsibility |
|---|---|
| `src/ui/import-state.ts` | Import controller: fillable rule, copy algorithm, per-file results, lifecycle |
| `src/ui/agent-import.ts` | `<agent-import>`: source picker, run button, result list |
| `src/ui/agent-persona.ts` | Hosts the import action in the pane header |
| `src/ui/persona-state.ts` | Gains `invalidate(agentId)` and `hasUnsavedDraft(agentId, name)` |
| `src/ui/agent-state.ts` | Exposes the unfiltered agent list for the source picker |
| `src/ui/agent-studio-app.ts` | Wires the controller to the component and the persona store |
| `test/ui/helpers/file-server.ts` | The agent-keyed fixture, lifted out of `persona.test.ts` for reuse |
| `test/ui/import.test.ts` | Controller, component, and app-integration tests |

## Controller

```ts
createImportController({
  api,
  connectionId,
  features,
  hasUnsavedDraft,   // (agentId, name) => boolean
}): ImportController
```

`hasUnsavedDraft` is supplied by the app from the persona store rather than the controller
importing the store, so the controller stays independently testable: its tests pass a plain
predicate instead of standing up an editor.

```ts
type ImportFileOutcome =
  | "written"
  | "skipped"          // target has content, or an unsaved draft
  | "empty-in-source"
  | "too-large"        // source exceeds MAX_PERSONA_CHARACTERS
  | "failed"
  | "not-attempted";   // run aborted before reaching this file

type ImportState = {
  status: "idle" | "running" | "done" | "error";
  targetAgentId?: string;
  sourceAgentId?: string;
  results: { name: string; outcome: ImportFileOutcome }[];
  errorText?: string;  // run-level abort only; per-file problems live in results
};
```

`run(targetAgentId, sourceAgentId)` processes the seven files **sequentially**, in the order
above, so an abort has a well-defined boundary. For each file:

1. Read the source. Missing or fillable → `empty-in-source`. Longer than
   `MAX_PERSONA_CHARACTERS` (60,000, the bound `setAgentFile` enforces) → `too-large`; the
   write would be rejected as an invalid payload and the operator would otherwise see only a
   generic failure.
2. Read the target. Not fillable → `skipped`.
3. Write the source content to the target → `written`.

`results` always has one entry per file in the copy set, whatever the outcome, so the
component can render a complete list. Available only when the Gateway advertises both
`getAgentFile` and `setAgentFile`.

## Correctness under agent switching

The panel's earlier defects came from attributing an async result to whichever agent was
selected when it landed. This controller follows the corrected rule:

- `run` captures `targetAgentId` and `sourceAgentId` at entry and addresses every read and
  write to the captured ids. Switching agents mid-run cannot redirect a write.
- A run still in flight when the operator switches agents completes against its original
  target. The component renders results only while `state.targetAgentId` matches the agent on
  screen, so one agent's results never appear under another.
- One run at a time: `run` returns immediately when `status === "running"`.

## Refreshing the editor after a write

`invalidate(agentId)` must **reload, not just drop**. Dropping the cache entry for the file
on screen would leave `PersonaState.file` undefined, and the pane renders nothing for that —
tabs with no editor and no notice — because the app only auto-selects a file when nothing is
selected. So `invalidate`:

- re-reads the currently selected file for that agent and replaces its cached editor;
- drops other cached entries for that agent, so they reload when next opened;
- **skips any editor that is dirty, saving, loading, in create mode, or showing a conflict.**
  Each of those holds state the operator would lose. A dirty file was skipped by import
  anyway, and a `saving` editor has a completing write whose result would otherwise be
  swallowed when its cache entry disappears.

It also marks every written file as present in `PersonaState.files`, so the "not created yet"
dots and the Create-file affordance clear immediately rather than when the operator happens
to open that tab.

The selected file tab does not change.

## Error handling

- A per-file read or write failure records `failed` and the run continues; it ends
  `status: "done"` with the outcome list naming what failed.
- `CONNECTION_EXPIRED` aborts the run with `status: "error"`, since every remaining request
  would fail identically. The file that raised it is recorded `failed`; every file after it is
  `not-attempted`. The panel's existing expiry handling takes over.
- Error text is fixed UI copy. Gateway messages are never surfaced.

## Interface

`<agent-import>` is presentational: it takes `state`, the target agent id, and the candidate
sources, and emits `import-run` with the chosen source id. It holds only the picker's current
selection.

The candidate list is the **unfiltered** agent list minus the target. `AgentDirectoryState.agents`
is filtered by the directory search box, so wiring the picker to it would make the source list
shrink as the operator types in an unrelated field; `agent-state.ts` gains an unfiltered
accessor for this.

The action sits in the Persona pane header, next to the file tabs — these are the files it
writes. It is hidden when the persona pane is in its error state, where there is no tab strip
to sit beside. When `setAgentFile` is unavailable the pane already shows a read-only notice,
so the import action is simply absent rather than adding a second notice saying the same
thing.

## Testing

Fillable rule, as a unit: missing, empty, whitespace-only, and the exact OpenClaw stub for
each of the seven files are fillable; a stub with one label filled in is not; prose under a
heading is not; a file whose editor holds an unsaved draft is not.

Controller: writes a fillable target; skips one with content, leaving it byte-identical;
reports `empty-in-source` for a stub source; reports `too-large` past 60,000 characters; one
file's failure does not stop the rest; `CONNECTION_EXPIRED` aborts and marks the remainder
`not-attempted`; a second `run` during one in flight is ignored; every write is addressed to
the target captured at entry even when the selection changes mid-run.

Component: the picker excludes the target and is not affected by the directory search; results
render per file; another target's results are not shown; the action is absent when the Gateway
lacks the methods and when the pane is in its error state.

Integration: import, then the Persona tab shows imported content rather than a stale cached
editor; an editor with unsaved changes keeps its draft and its file is left untouched on the
server.

Tests use the agent-keyed `fileServer` fixture, moved to `test/ui/helpers/file-server.ts` — a
fixture keyed by filename alone cannot tell a correctly addressed write from a misaddressed
one.

## Accepted trade-offs

**Import scaffolds; it does not sync.** Once an agent's files have content, re-importing an
edited template does nothing, because nothing is fillable. Pushing later template changes into
configured agents needs a diff-and-choose surface, which is out of scope.

**A template agent is an ordinary agent**, so it appears in `agents.list` and the directory
count, carries a model config like any other, and — because the session bar renders for
whichever agent is selected — can be spawned by mistake from its own page. Accepted: the
alternative is config keys and filtering rules for a convention one operator adopts. Name it
so it reads as inert (`_template`).

**Creating the agent still happens in the CLI.** `agents.create` is not in the broker's
allowlist and the parent spec lists agent creation as a non-goal, so the workflow is
`openclaw agents add` followed by import in the panel.

## Out of scope

Diff or preview before writing; re-sync and drift detection; template versioning; an overwrite
mode; per-file selection; hiding template agents from the directory; any configuration key;
agent creation.

## Release notes

Panel-only change: `dist/index.js` is unaffected, but the panel bundle changes, so the plugin
must still be rebuilt, packed, and redeployed with `deploy-agent-studio.ps1`.
