import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_COLOR_PALETTE,
  createAgentDirectoryStore,
  normalizeHexColor,
  type AgentDirectoryState,
} from "../../src/ui/agent-state.js";
import "../../src/ui/agent-directory.js";
import type { AgentDirectory } from "../../src/ui/agent-directory.js";
import "../../src/ui/agent-studio-app.js";
import type { AgentStudioApp } from "../../src/ui/agent-studio-app.js";
import type { AgentStudioFeatures } from "../../src/ui/api-client.js";

const connectionId = "c".repeat(64);

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

const agentsPayload = {
  defaultId: "scout",
  agents: [
    { id: "zephyr", name: "Zephyr", identity: { name: "Zephyr", emoji: "🜂" } },
    { id: "atlas", name: "Atlas", model: { primary: "opus" } },
    { id: "scout", name: "Scout" },
    { id: "beacon", identity: { name: "atlas-relay" } },
  ],
};

type OperationCall = { operation: string; payload: Record<string, unknown> };

function stubApi(
  handlers: Partial<Record<string, (payload: Record<string, unknown>) => Promise<unknown>>>,
  calls: OperationCall[] = [],
) {
  return {
    calls,
    operation: vi.fn(async (id: string, operation: string, payload: Record<string, unknown>) => {
      expect(id).toBe(connectionId);
      calls.push({ operation, payload });
      const handler = handlers[operation];
      if (!handler) throw new Error(`unexpected operation ${operation}`);
      return await handler(payload);
    }),
  };
}

function defaultHandlers(colors: Record<string, string> = {}) {
  return {
    listAgents: async () => agentsPayload,
    "colors.list": async () => ({ colors }),
    "colors.set": async (payload: Record<string, unknown>) => ({
      agentId: payload.agentId,
      color: payload.color,
    }),
  };
}

function labels(state: AgentDirectoryState): string[] {
  return state.agents.map((agent) => agent.label);
}

async function renderDirectory(state: AgentDirectoryState): Promise<AgentDirectory> {
  const directory = document.createElement("agent-directory") as AgentDirectory;
  directory.state = state;
  document.body.append(directory);
  await directory.updateComplete;
  return directory;
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`missing ${selector}`);
  return value;
}

async function readyState(
  overrides: Partial<Parameters<typeof createAgentDirectoryStore>[0]> = {},
  colors: Record<string, string> = {},
): Promise<AgentDirectoryState> {
  const store = createAgentDirectoryStore({
    api: stubApi(defaultHandlers(colors)),
    connectionId,
    features,
    ...overrides,
  });
  await store.load();
  return store.getState();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("agent directory store", () => {
  it("reports a loading phase then a sorted, default-first ready state", async () => {
    const store = createAgentDirectoryStore({
      api: stubApi(defaultHandlers({ atlas: "#7fd1c1" })),
      connectionId,
      features,
    });
    const seen: string[] = [];
    store.subscribe((state) => seen.push(state.status));

    expect(store.getState().status).toBe("idle");
    const loaded = store.load();
    expect(store.getState().status).toBe("loading");
    await loaded;

    const state = store.getState();
    expect(seen).toContain("loading");
    expect(state.status).toBe("ready");
    expect(labels(state)).toEqual(["Scout", "Atlas", "atlas-relay", "Zephyr"]);
    expect(state.agents.map((agent) => agent.id)).toEqual(["scout", "atlas", "beacon", "zephyr"]);
    expect(state.selectedId).toBe("scout");
    expect(state.totalCount).toBe(4);
    expect(state.agents.find((agent) => agent.id === "atlas")?.color).toBe("#7fd1c1");
  });

  it("still lists agents when color state cannot be read", async () => {
    const store = createAgentDirectoryStore({
      api: stubApi({
        ...defaultHandlers(),
        "colors.list": async () => {
          throw new Error("unavailable");
        },
      }),
      connectionId,
      features,
    });

    await store.load();

    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.agents).toHaveLength(4);
    expect(state.agents.every((agent) => agent.color === undefined)).toBe(true);
  });

  it("reports empty and error states without agents", async () => {
    const empty = createAgentDirectoryStore({
      api: stubApi({ ...defaultHandlers(), listAgents: async () => ({ agents: [] }) }),
      connectionId,
      features,
    });
    await empty.load();
    expect(empty.getState()).toMatchObject({ status: "ready", totalCount: 0, selectedId: undefined });

    const failing = createAgentDirectoryStore({
      api: stubApi({
        ...defaultHandlers(),
        listAgents: async () => {
          throw new Error("gateway down");
        },
      }),
      connectionId,
      features,
    });
    await failing.load();
    expect(failing.getState().status).toBe("error");
    expect(failing.getState().errorText).toBe("Agent directory unavailable.");
    expect(failing.getState().errorText).not.toContain("gateway down");

    const unsupported = createAgentDirectoryStore({
      api: stubApi(defaultHandlers()),
      connectionId,
      features: { ...features, listAgents: false },
    });
    await unsupported.load();
    expect(unsupported.getState().status).toBe("error");
    expect(unsupported.getState().errorText).toBe("This Gateway does not expose agent listing.");
  });

  it("searches by name and id and keeps the selection stable", async () => {
    const store = createAgentDirectoryStore({
      api: stubApi(defaultHandlers()),
      connectionId,
      features,
    });
    await store.load();

    store.setQuery("  ATL  ");
    expect(labels(store.getState())).toEqual(["Atlas", "atlas-relay"]);
    expect(store.getState().selectedId).toBe("scout");

    store.setQuery("zeph");
    expect(store.getState().agents.map((agent) => agent.id)).toEqual(["zephyr"]);

    store.setQuery("beacon");
    expect(store.getState().agents.map((agent) => agent.id)).toEqual(["beacon"]);

    store.setQuery("nothing-matches");
    expect(store.getState().agents).toEqual([]);
    expect(store.getState().totalCount).toBe(4);

    store.setQuery("");
    expect(store.getState().agents).toHaveLength(4);

    store.select("zephyr");
    expect(store.getState().selectedId).toBe("zephyr");
    store.select("not-an-agent");
    expect(store.getState().selectedId).toBe("zephyr");
  });

  it("applies a color optimistically and rolls back a failed save", async () => {
    const calls: OperationCall[] = [];
    let failNext = false;
    const store = createAgentDirectoryStore({
      api: stubApi(
        {
          ...defaultHandlers({ atlas: "#111111" }),
          "colors.set": async (payload) => {
            if (failNext) throw new Error("disk full");
            return { agentId: payload.agentId, color: payload.color };
          },
        },
        calls,
      ),
      connectionId,
      features,
    });
    await store.load();

    const pending = store.setColor("atlas", "#FF8866");
    expect(store.getState().agents.find((agent) => agent.id === "atlas")?.color).toBe("#ff8866");
    await pending;
    expect(store.getState().agents.find((agent) => agent.id === "atlas")?.color).toBe("#ff8866");
    expect(store.getState().colorErrorText).toBeUndefined();
    expect(calls.at(-1)).toEqual({
      operation: "colors.set",
      payload: { agentId: "atlas", color: "#ff8866" },
    });

    failNext = true;
    await store.setColor("atlas", "#123456");
    expect(store.getState().agents.find((agent) => agent.id === "atlas")?.color).toBe("#ff8866");
    expect(store.getState().colorErrorText).toBe("Could not save that color. Reverting.");

    failNext = false;
    await store.setColor("zephyr", "#abcdef");
    expect(store.getState().colorErrorText).toBeUndefined();
    expect(store.getState().agents.find((agent) => agent.id === "zephyr")?.color).toBe("#abcdef");
  });

  it("rejects invalid colors before contacting the broker", async () => {
    const calls: OperationCall[] = [];
    const store = createAgentDirectoryStore({
      api: stubApi(defaultHandlers(), calls),
      connectionId,
      features,
    });
    await store.load();
    const before = calls.length;

    await store.setColor("atlas", "not-a-color");

    expect(calls).toHaveLength(before);
    expect(store.getState().colorErrorText).toBe("Enter a color as #rrggbb.");
  });
});

describe("color normalization", () => {
  it("normalizes accepted forms and rejects everything else", () => {
    expect(normalizeHexColor("#AABBCC")).toBe("#aabbcc");
    expect(normalizeHexColor("aabbcc")).toBe("#aabbcc");
    expect(normalizeHexColor(" #abc ")).toBe("#aabbcc");
    expect(normalizeHexColor("#abcd")).toBeUndefined();
    expect(normalizeHexColor("#gggggg")).toBeUndefined();
    expect(normalizeHexColor("")).toBeUndefined();
    expect(normalizeHexColor(undefined)).toBeUndefined();
    expect(AGENT_COLOR_PALETTE.every((color) => normalizeHexColor(color) === color)).toBe(true);
  });
});

describe("agent directory component", () => {
  it("renders loading, empty, no-match, and error surfaces", async () => {
    const base = await readyState();

    const loading = await renderDirectory({ ...base, status: "loading", agents: [], totalCount: 0 });
    expect(query<HTMLElement>(loading, '[data-state="loading"]').textContent).toContain(
      "Loading agents",
    );

    const empty = await renderDirectory({ ...base, agents: [], totalCount: 0, selectedId: undefined });
    expect(empty.textContent).toContain("No agents available");

    const noMatch = await renderDirectory({ ...base, agents: [], query: "zzz" });
    expect(noMatch.textContent).toContain("No agents match");

    const failed = await renderDirectory({
      ...base,
      status: "error",
      agents: [],
      totalCount: 0,
      errorText: "Agent directory unavailable.",
    });
    expect(query<HTMLElement>(failed, '[role="alert"]').textContent).toContain(
      "Agent directory unavailable.",
    );
  });

  it("marks selection without relying on color and emits selection events", async () => {
    const state = await readyState({}, { scout: "#7fd1c1" });
    const directory = await renderDirectory(state);
    const selections: string[] = [];
    directory.addEventListener("agent-select", (event) => {
      selections.push((event as CustomEvent<{ agentId: string }>).detail.agentId);
    });

    const rows = directory.querySelectorAll<HTMLElement>(".agent-row");
    expect(rows).toHaveLength(4);
    const selected = query<HTMLButtonElement>(directory, '.agent-select[aria-current="true"]');
    expect(selected.closest(".agent-row")?.getAttribute("data-agent-id")).toBe("scout");
    expect(selected.querySelector(".selected-marker")).not.toBeNull();
    expect(selected.textContent).toContain("Selected");
    expect(query<HTMLElement>(directory, '.agent-row[data-agent-id="scout"] .agent-swatch')
      .getAttribute("data-color")).toBe("#7fd1c1");
    expect(
      directory.querySelectorAll('.agent-select[aria-current="true"]'),
    ).toHaveLength(1);

    query<HTMLButtonElement>(directory, '.agent-row[data-agent-id="zephyr"] .agent-select').click();
    expect(selections).toEqual(["zephyr"]);
  });

  it("supports roving-tabindex keyboard navigation over the list", async () => {
    const directory = await renderDirectory(await readyState());
    const selections: string[] = [];
    directory.addEventListener("agent-select", (event) => {
      selections.push((event as CustomEvent<{ agentId: string }>).detail.agentId);
    });
    const buttons = [...directory.querySelectorAll<HTMLButtonElement>(".agent-select")];

    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1]);

    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(buttons[1]);
    expect(selections).toEqual(["atlas"]);

    buttons[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(buttons[3]);
    expect(selections).toEqual(["atlas", "zephyr"]);

    buttons[3].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(buttons[3]);

    buttons[3].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
    expect(selections).toEqual(["atlas", "zephyr", "scout"]);

    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("emits query changes from the search field", async () => {
    const directory = await renderDirectory(await readyState());
    const queries: string[] = [];
    directory.addEventListener("agent-query", (event) => {
      queries.push((event as CustomEvent<{ query: string }>).detail.query);
    });

    const search = query<HTMLInputElement>(directory, "#agent-search");
    expect(search.getAttribute("aria-label")).toBe("Search agents");
    search.value = "atl";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(queries).toEqual(["atl"]);
  });

  it("offers an accessible palette and validated custom hex entry", async () => {
    const directory = await renderDirectory(await readyState());
    const colors: Array<{ agentId: string; color: string }> = [];
    directory.addEventListener("agent-color", (event) => {
      colors.push((event as CustomEvent<{ agentId: string; color: string }>).detail);
    });

    const trigger = query<HTMLButtonElement>(
      directory,
      '.agent-row[data-agent-id="atlas"] .color-trigger',
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("Set color for Atlas");

    trigger.click();
    await directory.updateComplete;
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const popover = query<HTMLElement>(directory, ".color-popover");
    const swatches = [...popover.querySelectorAll<HTMLButtonElement>(".palette-swatch")];
    expect(swatches).toHaveLength(AGENT_COLOR_PALETTE.length);
    expect(swatches.map((swatch) => swatch.getAttribute("data-color"))).toEqual([
      ...AGENT_COLOR_PALETTE,
    ]);
    expect(swatches[0].getAttribute("aria-label")).toBeTruthy();

    swatches[2].click();
    await directory.updateComplete;
    expect(colors).toEqual([{ agentId: "atlas", color: AGENT_COLOR_PALETTE[2] }]);
    expect(directory.querySelector(".color-popover")).toBeNull();

    trigger.click();
    await directory.updateComplete;
    const custom = query<HTMLInputElement>(directory, ".custom-hex");
    custom.value = "nope";
    query<HTMLButtonElement>(directory, ".custom-apply").click();
    await directory.updateComplete;
    expect(query<HTMLElement>(directory, '[data-error="hex"]').textContent).toContain(
      "#rrggbb",
    );
    expect(colors).toHaveLength(1);
    expect(directory.querySelector(".color-popover")).not.toBeNull();

    custom.value = "#0F0F0F";
    query<HTMLButtonElement>(directory, ".custom-apply").click();
    await directory.updateComplete;
    expect(colors.at(-1)).toEqual({ agentId: "atlas", color: "#0f0f0f" });
    expect(directory.querySelector(".color-popover")).toBeNull();

    trigger.click();
    await directory.updateComplete;
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await directory.updateComplete;
    expect(directory.querySelector(".color-popover")).toBeNull();
  });
});

describe("Agent Studio app directory integration", () => {
  async function connectedApp(
    handlers = defaultHandlers({ atlas: "#7fd1c1" }),
    calls: OperationCall[] = [],
  ): Promise<AgentStudioApp> {
    const api = stubApi(handlers, calls);
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
    await vi.waitFor(() => expect(app.connectionId).toBe(connectionId));
    return app;
  }

  it("loads agents and colors after connecting and selects the default agent", async () => {
    const calls: OperationCall[] = [];
    const app = await connectedApp(defaultHandlers({ atlas: "#7fd1c1" }), calls);

    await vi.waitFor(() =>
      expect(app.querySelectorAll(".agent-row").length).toBe(4));

    expect(calls.map((call) => call.operation).sort()).toEqual(["colors.list", "listAgents"]);
    expect(calls.every((call) => Object.keys(call.payload).length === 0)).toBe(true);
    const selected = query<HTMLButtonElement>(app, '.agent-select[aria-current="true"]');
    expect(selected.closest(".agent-row")?.getAttribute("data-agent-id")).toBe("scout");
    expect(app.querySelector(".directory-placeholder")).toBeNull();
  });

  it("filters from the search box and persists a chosen color", async () => {
    const calls: OperationCall[] = [];
    const app = await connectedApp(defaultHandlers(), calls);
    await vi.waitFor(() => expect(app.querySelectorAll(".agent-row").length).toBe(4));

    const search = query<HTMLInputElement>(app, "#agent-search");
    search.value = "atl";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(app.querySelectorAll(".agent-row").length).toBe(2));

    query<HTMLButtonElement>(app, '.agent-row[data-agent-id="atlas"] .color-trigger').click();
    await app.updateComplete;
    query<HTMLButtonElement>(app, ".palette-swatch").click();

    await vi.waitFor(() =>
      expect(calls.some((call) => call.operation === "colors.set")).toBe(true));
    expect(calls.at(-1)).toEqual({
      operation: "colors.set",
      payload: { agentId: "atlas", color: AGENT_COLOR_PALETTE[0] },
    });
    await vi.waitFor(() =>
      expect(
        app.querySelector('.agent-row[data-agent-id="atlas"] .agent-swatch')
          ?.getAttribute("data-color"),
      ).toBe(AGENT_COLOR_PALETTE[0]));
  });

  it("drops directory state on disconnect", async () => {
    const app = await connectedApp();
    await vi.waitFor(() => expect(app.querySelectorAll(".agent-row").length).toBe(4));

    query<HTMLButtonElement>(app, "#disconnect").click();
    await vi.waitFor(() => expect(app.connectionId).toBeUndefined());

    expect(app.querySelector(".agent-row")).toBeNull();
    expect(app.querySelector("agent-directory")).toBeNull();
  });
});
