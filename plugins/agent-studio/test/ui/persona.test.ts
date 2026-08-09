import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStudioApiError, type AgentStudioFeatures } from "../../src/ui/api-client.js";
import {
  PERSONA_FILES,
  createPersonaStore,
  type PersonaState,
  type PersonaStore,
} from "../../src/ui/persona-state.js";
import "../../src/ui/agent-persona.js";
import type { AgentPersona } from "../../src/ui/agent-persona.js";
import "../../src/ui/agent-studio-app.js";
import type { AgentStudioApp } from "../../src/ui/agent-studio-app.js";

const connectionId = "f".repeat(64);

const features: AgentStudioFeatures = {
  listAgents: true,
  updateAgent: true,
  listAgentFiles: true,
  getAgentFile: true,
  setAgentFile: true,
  listModels: true,
  listSessions: true,
  createSession: true,
};

type Handlers = Record<string, (payload: Record<string, unknown>) => Promise<unknown>>;
type Call = { operation: string; payload: Record<string, unknown> };

function stubApi(handlers: Handlers, calls: Call[] = []) {
  return {
    operation: async (id: string, operation: string, payload: Record<string, unknown>) => {
      expect(id).toBe(connectionId);
      calls.push({ operation, payload });
      const handler = handlers[operation];
      if (!handler) throw new AgentStudioApiError("OPERATION_FAILED");
      return await handler(payload);
    },
  };
}

/**
 * A tiny in-memory agent file server that mirrors the broker's projected shapes.
 *
 * Storage is keyed by (agentId, name), not by name alone: a fixture that ignores
 * the requested agent cannot tell a correctly addressed write from one aimed at
 * the wrong agent, which is exactly the class of bug worth catching here.
 */
function fileServer(
  initial: Record<string, string> = { "AGENTS.md": "original agents" },
  agentId = "atlas",
) {
  const store = new Map<string, Map<string, string>>([
    [agentId, new Map(Object.entries(initial))],
  ]);
  const forAgent = (id: string): Map<string, string> => {
    const existing = store.get(id);
    if (existing) return existing;
    const created = new Map<string, string>();
    store.set(id, created);
    return created;
  };

  return {
    store,
    /** Files of the agent the fixture was seeded for. */
    contents: forAgent(agentId),
    contentsOf: (id: string) => forAgent(id),
    handlers: {
      listAgentFiles: async (payload: Record<string, unknown>) => {
        const contents = forAgent(String(payload.agentId));
        return {
          agentId: payload.agentId,
          files: PERSONA_FILES.map((name) => ({ name, missing: !contents.has(name) })),
        };
      },
      getAgentFile: async (payload: Record<string, unknown>) => {
        const name = String(payload.name);
        const content = forAgent(String(payload.agentId)).get(name);
        return {
          agentId: payload.agentId,
          file: content === undefined ? { name, missing: true } : { name, content },
        };
      },
      setAgentFile: async (payload: Record<string, unknown>) => {
        const name = String(payload.name);
        forAgent(String(payload.agentId)).set(name, String(payload.content));
        return { ok: true, agentId: payload.agentId, file: { name, content: payload.content } };
      },
    } satisfies Handlers,
  };
}

async function readyStore(
  overrides: { handlers?: Handlers; calls?: Call[]; features?: AgentStudioFeatures } = {},
): Promise<PersonaStore> {
  const server = fileServer();
  const store = createPersonaStore({
    api: stubApi(overrides.handlers ?? server.handlers, overrides.calls),
    connectionId,
    features: overrides.features ?? features,
  });
  await store.selectAgent("atlas");
  return store;
}

async function renderPersona(state: PersonaState): Promise<AgentPersona> {
  const persona = document.createElement("agent-persona") as AgentPersona;
  persona.state = state;
  document.body.append(persona);
  await persona.updateComplete;
  return persona;
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`missing ${selector}`);
  return value;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("persona store", () => {
  it("exposes a tab per core file and loads only the selected one", async () => {
    const calls: Call[] = [];
    const server = fileServer();
    const store = await readyStore({ handlers: server.handlers, calls });

    expect(store.getState().files.map((file) => file.name)).toEqual([...PERSONA_FILES]);
    expect(store.getState().files.find((file) => file.name === "SOUL.md")?.missing).toBe(true);
    expect(calls.map((call) => call.operation)).toEqual(["listAgentFiles"]);

    await store.selectFile("AGENTS.md");

    expect(calls.map((call) => call.operation)).toEqual(["listAgentFiles", "getAgentFile"]);
    expect(calls.at(-1)?.payload).toEqual({ agentId: "atlas", name: "AGENTS.md" });
    expect(store.getState().file).toMatchObject({
      name: "AGENTS.md",
      status: "ready",
      draft: "original agents",
      dirty: false,
    });
  });

  it("caches a loaded file for the panel session and restores unsaved drafts", async () => {
    const calls: Call[] = [];
    const server = fileServer({ "AGENTS.md": "original agents", "USER.md": "user notes" });
    const store = await readyStore({ handlers: server.handlers, calls });

    await store.selectFile("AGENTS.md");
    store.setDraft("edited agents");
    await store.selectFile("USER.md");
    expect(store.getState().file?.draft).toBe("user notes");

    const before = calls.filter((call) => call.operation === "getAgentFile").length;
    await store.selectFile("AGENTS.md");

    expect(calls.filter((call) => call.operation === "getAgentFile")).toHaveLength(before);
    expect(store.getState().file).toMatchObject({ draft: "edited agents", dirty: true });
  });

  it("creates a missing file and saves it as new content", async () => {
    const server = fileServer();
    const store = await readyStore({ handlers: server.handlers });

    await store.selectFile("SOUL.md");
    expect(store.getState().file).toMatchObject({ missing: true, draft: "", dirty: false });

    store.createFile();
    expect(store.getState().file).toMatchObject({ missing: true, dirty: false });
    store.setDraft("a new soul");
    expect(store.getState().file?.dirty).toBe(true);

    await store.save();

    expect(server.contents.get("SOUL.md")).toBe("a new soul");
    expect(store.getState().file).toMatchObject({ dirty: false, missing: false, saved: true });
    expect(store.getState().files.find((file) => file.name === "SOUL.md")?.missing).toBe(false);
  });

  it("tracks dirty state and reloads the server copy on cancel", async () => {
    const server = fileServer();
    const store = await readyStore({ handlers: server.handlers });
    await store.selectFile("AGENTS.md");

    store.setDraft("local edit");
    expect(store.getState().file?.dirty).toBe(true);
    store.setDraft("original agents");
    expect(store.getState().file?.dirty).toBe(false);

    store.setDraft("local edit again");
    server.contents.set("AGENTS.md", "changed elsewhere");
    await store.cancel();

    expect(store.getState().file).toMatchObject({ draft: "changed elsewhere", dirty: false });
  });

  it("saves successfully and records the new original", async () => {
    const calls: Call[] = [];
    const server = fileServer();
    const store = await readyStore({ handlers: server.handlers, calls });
    await store.selectFile("AGENTS.md");
    store.setDraft("revised agents");

    await store.save();

    expect(server.contents.get("AGENTS.md")).toBe("revised agents");
    expect(store.getState().file).toMatchObject({ dirty: false, saved: true, conflict: undefined });
    // the pre-save reload proves no concurrent edit before writing
    expect(calls.map((call) => call.operation)).toEqual([
      "listAgentFiles",
      "getAgentFile",
      "getAgentFile",
      "setAgentFile",
    ]);

    store.setDraft("revised agents");
    expect(store.getState().file?.dirty).toBe(false);
  });

  it("rejects oversized content locally without calling the broker", async () => {
    const calls: Call[] = [];
    const server = fileServer();
    const store = await readyStore({ handlers: server.handlers, calls });
    await store.selectFile("AGENTS.md");
    store.setDraft("x".repeat(60_001));

    await store.save();

    expect(calls.filter((call) => call.operation === "setAgentFile")).toHaveLength(0);
    expect(store.getState().file?.errorText).toBe("This file is too large to save (60,000 characters max).");
    expect(store.getState().file?.dirty).toBe(true);
  });

  it("surfaces a conflict instead of overwriting a concurrent edit", async () => {
    const server = fileServer();
    const store = await readyStore({ handlers: server.handlers });
    await store.selectFile("AGENTS.md");
    store.setDraft("my version");
    server.contents.set("AGENTS.md", "their version");

    await store.save();

    expect(server.contents.get("AGENTS.md")).toBe("their version");
    expect(store.getState().file?.conflict).toEqual({
      server: "their version",
      local: "my version",
    });

    await store.resolveConflict("keep-mine");

    expect(server.contents.get("AGENTS.md")).toBe("my version");
    expect(store.getState().file).toMatchObject({ dirty: false, conflict: undefined });
  });

  it("adopts the server version when the operator discards local edits", async () => {
    const server = fileServer();
    const store = await readyStore({ handlers: server.handlers });
    await store.selectFile("AGENTS.md");
    store.setDraft("my version");
    server.contents.set("AGENTS.md", "their version");
    await store.save();

    await store.resolveConflict("use-server");

    expect(server.contents.get("AGENTS.md")).toBe("their version");
    expect(store.getState().file).toMatchObject({
      draft: "their version",
      dirty: false,
      conflict: undefined,
    });
  });

  it("disables editing when the connection expires but keeps the draft", async () => {
    const server = fileServer();
    let expired = false;
    const store = await readyStore({
      handlers: {
        ...server.handlers,
        setAgentFile: async () => {
          throw new AgentStudioApiError("CONNECTION_EXPIRED");
        },
        getAgentFile: async (payload) => {
          if (expired) throw new AgentStudioApiError("CONNECTION_EXPIRED");
          return await server.handlers.getAgentFile(payload);
        },
      },
    });
    await store.selectFile("AGENTS.md");
    store.setDraft("work in progress");
    expired = true;

    await store.save();

    expect(store.getState().expired).toBe(true);
    expect(store.getState().file).toMatchObject({ draft: "work in progress", dirty: true });
  });

  it("reports an unavailable persona surface when the Gateway lacks the methods", async () => {
    const store = await readyStore({
      features: { ...features, listAgentFiles: false },
    });

    expect(store.getState().status).toBe("error");
    expect(store.getState().errorText).toBe("This Gateway does not expose agent files.");
  });

  it("marks the editor read-only when saving is unavailable", async () => {
    const server = fileServer();
    const store = await readyStore({
      handlers: server.handlers,
      features: { ...features, setAgentFile: false },
    });
    await store.selectFile("AGENTS.md");

    expect(store.getState().canSave).toBe(false);
  });
});

describe("persona store agent isolation", () => {
  /** Resolves the next call to `operation` for the given operation name. */
  function gated(handlers: Handlers, gateOperation: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      release,
      handlers: {
        ...handlers,
        [gateOperation]: async (payload: Record<string, unknown>) => {
          await gate;
          return await handlers[gateOperation](payload);
        },
      } as Handlers,
    };
  }

  it("writes a save to the agent being edited, not the one selected mid-flight", async () => {
    const server = fileServer({ "AGENTS.md": "atlas original" });
    server.contentsOf("zephyr").set("AGENTS.md", "zephyr original");
    const gate = gated(server.handlers, "getAgentFile");
    const calls: Call[] = [];
    const store = createPersonaStore({
      api: stubApi(gate.handlers, calls),
      connectionId,
      features,
    });

    await store.selectAgent("atlas");
    const loading = store.selectFile("AGENTS.md");
    gate.release();
    await loading;
    store.setDraft("atlas rewritten");

    const saving = store.save();
    // The operator switches agents while the pre-save reload is on the wire.
    await store.selectAgent("zephyr");
    await saving;

    expect(server.contentsOf("zephyr").get("AGENTS.md")).toBe("zephyr original");
    expect(server.contentsOf("atlas").get("AGENTS.md")).toBe("atlas rewritten");
    const writes = calls.filter((call) => call.operation === "setAgentFile");
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.agentId).toBe("atlas");
  });

  it("caches a late file response under the agent it was requested for", async () => {
    const server = fileServer({ "SOUL.md": "atlas soul" });
    server.contentsOf("zephyr").set("AGENTS.md", "zephyr agents");
    const gate = gated(server.handlers, "getAgentFile");
    const store = createPersonaStore({
      api: stubApi(gate.handlers),
      connectionId,
      features,
    });

    await store.selectAgent("atlas");
    const loading = store.selectFile("SOUL.md");
    await store.selectAgent("zephyr");
    gate.release();
    await loading;

    await store.selectFile("SOUL.md");
    expect(store.getState().file).toMatchObject({ missing: true, draft: "" });
    expect(store.getState().files.find((file) => file.name === "SOUL.md")?.missing).toBe(true);
  });

  it("ignores a stale file-list response for a previously selected agent", async () => {
    const server = fileServer({ "AGENTS.md": "atlas agents" });
    server.contentsOf("zephyr").set("SOUL.md", "zephyr soul");
    let held: (() => void) | undefined;
    const store = createPersonaStore({
      api: stubApi({
        ...server.handlers,
        listAgentFiles: async (payload) => {
          if (payload.agentId === "atlas") {
            await new Promise<void>((resolve) => {
              held = resolve;
            });
          }
          return await server.handlers.listAgentFiles(payload);
        },
      }),
      connectionId,
      features,
    });

    const first = store.selectAgent("atlas");
    const second = store.selectAgent("zephyr");
    await second;
    held?.();
    await first;

    expect(store.getState().agentId).toBe("zephyr");
    expect(store.getState().files.find((file) => file.name === "SOUL.md")?.missing).toBe(false);
    expect(store.getState().files.find((file) => file.name === "AGENTS.md")?.missing).toBe(true);
  });

  it("does not strand an editor in a saving state when the agent changes", async () => {
    const server = fileServer({ "AGENTS.md": "atlas original" });
    const gate = gated(server.handlers, "setAgentFile");
    const store = createPersonaStore({
      api: stubApi(gate.handlers),
      connectionId,
      features,
    });

    await store.selectAgent("atlas");
    await store.selectFile("AGENTS.md");
    store.setDraft("atlas rewritten");
    const saving = store.save();
    await store.selectAgent("zephyr");
    gate.release();
    await saving;

    await store.selectAgent("atlas");
    await store.selectFile("AGENTS.md");
    expect(store.getState().file).toMatchObject({ saving: false, dirty: false });
  });
});

describe("Agent Studio workspace integration", () => {
  async function connectedApp(calls: Call[] = []) {
    const server = fileServer({ "AGENTS.md": "atlas guidance" });
    const api = stubApi(
      {
        ...server.handlers,
        listAgents: async () => ({
          defaultId: "atlas",
          agents: [
            { id: "atlas", name: "Atlas", model: { primary: "opus" } },
            { id: "zephyr", name: "Zephyr" },
          ],
        }),
        "colors.list": async () => ({ colors: {} }),
        updateAgent: async (payload) => ({ ok: true, agentId: payload.agentId }),
      },
      calls,
    );
    const app = document.createElement("agent-studio-app") as AgentStudioApp;
    app.api = {
      connect: async () => ({ connectionId, features }),
      disconnect: vi.fn(async () => undefined),
      operation: api.operation,
    };
    document.body.append(app);
    await app.updateComplete;
    query<HTMLInputElement>(app, "#gateway-token").value = "temporary";
    query<HTMLButtonElement>(app, ".primary-action").click();
    await vi.waitFor(() => expect(app.querySelectorAll(".agent-row").length).toBe(2));
    return { app, server, calls };
  }

  it("opens on Overview and defers persona loading until its tab is chosen", async () => {
    const { app, calls } = await connectedApp();

    expect(query<HTMLElement>(app, '.workspace-tab[data-tab="overview"]').getAttribute(
      "aria-selected",
    )).toBe("true");
    expect(app.querySelector("agent-overview")).not.toBeNull();
    expect(calls.some((call) => call.operation === "listAgentFiles")).toBe(false);

    query<HTMLButtonElement>(app, '.workspace-tab[data-tab="persona"]').click();

    await vi.waitFor(() =>
      expect(app.querySelector<HTMLTextAreaElement>("#persona-editor")?.value).toBe(
        "atlas guidance",
      ));
    expect(calls.filter((call) => call.operation === "getAgentFile")).toHaveLength(1);
    expect(calls.at(-1)?.payload).toEqual({ agentId: "atlas", name: "AGENTS.md" });
  });

  it("saves an edited persona file through the broker", async () => {
    const { app, server } = await connectedApp();
    query<HTMLButtonElement>(app, '.workspace-tab[data-tab="persona"]').click();
    await vi.waitFor(() => expect(app.querySelector("#persona-editor")).not.toBeNull());

    const editor = query<HTMLTextAreaElement>(app, "#persona-editor");
    editor.value = "rewritten guidance";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(app.querySelector<HTMLButtonElement>(".persona-save")?.disabled).toBe(false));
    query<HTMLButtonElement>(app, ".persona-save").click();

    await vi.waitFor(() => expect(server.contents.get("AGENTS.md")).toBe("rewritten guidance"));
    await vi.waitFor(() =>
      expect(app.querySelector('[data-state="saved"]')).not.toBeNull());
  });

  it("reloads persona files when the selected agent changes", async () => {
    const { app, calls } = await connectedApp();
    query<HTMLButtonElement>(app, '.workspace-tab[data-tab="persona"]').click();
    await vi.waitFor(() => expect(app.querySelector("#persona-editor")).not.toBeNull());

    query<HTMLButtonElement>(app, '.agent-row[data-agent-id="zephyr"] .agent-select').click();

    await vi.waitFor(() =>
      expect(calls.filter((call) => call.operation === "listAgentFiles")).toHaveLength(2));
    expect(calls.filter((call) => call.operation === "listAgentFiles").at(-1)?.payload).toEqual({
      agentId: "zephyr",
    });
  });

  it("sends an overview rename to the Gateway and updates the directory row", async () => {
    const { app, calls } = await connectedApp();

    const name = query<HTMLInputElement>(app, "#overview-name");
    name.value = "Atlas Prime";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() =>
      expect(app.querySelector<HTMLButtonElement>(".overview-save")?.disabled).toBe(false));
    query<HTMLButtonElement>(app, ".overview-save").click();

    await vi.waitFor(() =>
      expect(calls.some((call) => call.operation === "updateAgent")).toBe(true));
    expect(calls.at(-1)?.payload).toEqual({ agentId: "atlas", name: "Atlas Prime" });
    await vi.waitFor(() =>
      expect(
        app.querySelector('.agent-row[data-agent-id="atlas"] .agent-label')?.textContent,
      ).toContain("Atlas Prime"));
  });
});

describe("persona component", () => {
  async function personaFor(store: PersonaStore): Promise<AgentPersona> {
    return await renderPersona(store.getState());
  }

  it("renders a tab per core file with the selected tab marked", async () => {
    const store = await readyStore();
    await store.selectFile("AGENTS.md");
    const persona = await personaFor(store);

    const tabs = [...persona.querySelectorAll<HTMLButtonElement>(".persona-tab")];
    expect(tabs.map((tab) => tab.getAttribute("data-file"))).toEqual([...PERSONA_FILES]);
    expect(query<HTMLElement>(persona, '[role="tablist"]')).toBeTruthy();
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].textContent).toContain("SOUL.md");

    const selected: string[] = [];
    persona.addEventListener("persona-select", (event) => {
      selected.push((event as CustomEvent<{ name: string }>).detail.name);
    });
    tabs[2].click();
    expect(selected).toEqual(["USER.md"]);
  });

  it("shows dirty state, disables save when clean, and emits editor events", async () => {
    const store = await readyStore();
    await store.selectFile("AGENTS.md");
    const clean = await personaFor(store);

    expect(query<HTMLButtonElement>(clean, ".persona-save").disabled).toBe(true);
    expect(query<HTMLButtonElement>(clean, ".persona-cancel").disabled).toBe(true);
    expect(clean.querySelector('[data-state="dirty"]')).toBeNull();

    store.setDraft("edited");
    const dirty = await renderPersona(store.getState());
    expect(query<HTMLButtonElement>(dirty, ".persona-save").disabled).toBe(false);
    expect(query<HTMLElement>(dirty, '[data-state="dirty"]').textContent).toContain(
      "Unsaved changes",
    );

    const events: string[] = [];
    dirty.addEventListener("persona-save", () => events.push("save"));
    dirty.addEventListener("persona-cancel", () => events.push("cancel"));
    dirty.addEventListener("persona-input", (event) =>
      events.push(`input:${(event as CustomEvent<{ text: string }>).detail.text}`));

    const editor = query<HTMLTextAreaElement>(dirty, "#persona-editor");
    editor.value = "typed";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    query<HTMLButtonElement>(dirty, ".persona-save").click();
    query<HTMLButtonElement>(dirty, ".persona-cancel").click();

    expect(events).toEqual(["input:typed", "save", "cancel"]);
  });

  it("offers creation for a missing file and hides the editor until then", async () => {
    const store = await readyStore();
    await store.selectFile("SOUL.md");
    const missing = await personaFor(store);

    expect(query<HTMLElement>(missing, '[data-state="missing"]').textContent).toContain(
      "SOUL.md does not exist yet",
    );
    const created: number[] = [];
    missing.addEventListener("persona-create", () => created.push(1));
    query<HTMLButtonElement>(missing, ".persona-create").click();
    expect(created).toHaveLength(1);

    store.createFile();
    const creating = await renderPersona(store.getState());
    expect(creating.querySelector("#persona-editor")).not.toBeNull();
    expect(creating.querySelector(".persona-create")).toBeNull();
  });

  it("presents both versions of a conflict and requires an explicit choice", async () => {
    const server = fileServer();
    const store = await readyStore({ handlers: server.handlers });
    await store.selectFile("AGENTS.md");
    store.setDraft("my version");
    server.contents.set("AGENTS.md", "their version");
    await store.save();

    const persona = await personaFor(store);
    const conflict = query<HTMLElement>(persona, ".persona-conflict");
    expect(conflict.getAttribute("role")).toBe("alertdialog");
    expect(query<HTMLElement>(conflict, ".conflict-server").textContent).toContain("their version");
    expect(query<HTMLElement>(conflict, ".conflict-local").textContent).toContain("my version");
    expect(query<HTMLButtonElement>(persona, "#persona-editor").disabled).toBe(true);

    const choices: string[] = [];
    persona.addEventListener("persona-resolve", (event) => {
      choices.push((event as CustomEvent<{ choice: string }>).detail.choice);
    });
    query<HTMLButtonElement>(conflict, ".conflict-keep").click();
    query<HTMLButtonElement>(conflict, ".conflict-discard").click();

    expect(choices).toEqual(["keep-mine", "use-server"]);
  });

  it("locks the editor while the connection is expired and shows validation errors", async () => {
    const store = await readyStore();
    await store.selectFile("AGENTS.md");
    store.setDraft("x".repeat(60_001));
    await store.save();

    const invalid = await personaFor(store);
    expect(query<HTMLElement>(invalid, '[role="alert"]').textContent).toContain("too large");
    expect(query<HTMLTextAreaElement>(invalid, "#persona-editor").disabled).toBe(false);

    const expired = await renderPersona({ ...store.getState(), expired: true });
    expect(query<HTMLTextAreaElement>(expired, "#persona-editor").disabled).toBe(true);
    expect(query<HTMLElement>(expired, '[data-state="expired"]').textContent).toContain(
      "Reconnect to continue editing",
    );
    expect(query<HTMLTextAreaElement>(expired, "#persona-editor").value).toContain("x".repeat(20));
  });

  it("marks the editor read-only when the Gateway cannot save files", async () => {
    const store = await readyStore({ features: { ...features, setAgentFile: false } });
    await store.selectFile("AGENTS.md");
    const persona = await personaFor(store);

    expect(query<HTMLTextAreaElement>(persona, "#persona-editor").readOnly).toBe(true);
    expect(persona.querySelector(".persona-save")).toBeNull();
    expect(query<HTMLElement>(persona, '[data-state="read-only"]').textContent).toContain(
      "read-only",
    );
  });
});
