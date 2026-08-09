import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStudioFeatures } from "../../src/ui/api-client.js";
import type { DirectoryAgent } from "../../src/ui/agent-state.js";
import { createAgentDirectoryStore } from "../../src/ui/agent-state.js";
import "../../src/ui/agent-overview.js";
import type { AgentOverview } from "../../src/ui/agent-overview.js";

const connectionId = "0".repeat(64);

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

const atlas: DirectoryAgent = {
  id: "atlas",
  label: "Atlas",
  model: "opus",
  color: "#7fd1c1",
  workspaceGit: true,
};

function query<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`missing ${selector}`);
  return value;
}

async function renderOverview(
  properties: Partial<AgentOverview> = {},
): Promise<AgentOverview> {
  const overview = document.createElement("agent-overview") as AgentOverview;
  overview.agent = atlas;
  overview.features = features;
  Object.assign(overview, properties);
  document.body.append(overview);
  await overview.updateComplete;
  return overview;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("agent overview", () => {
  it("shows the agent's identity facts", async () => {
    const overview = await renderOverview();

    expect(query<HTMLElement>(overview, '[data-fact="id"]').textContent).toContain("atlas");
    expect(query<HTMLElement>(overview, '[data-fact="model"]').textContent).toContain("opus");
    expect(query<HTMLElement>(overview, '[data-fact="workspace"]').textContent).toContain("Git");
    expect(overview.textContent).toContain("Atlas");
  });

  it("prompts for a selection when no agent is chosen", async () => {
    const overview = await renderOverview({ agent: undefined });

    expect(overview.textContent).toContain("Select an agent");
    expect(overview.querySelector("#overview-name")).toBeNull();
  });

  it("edits the fields the Gateway advertises and emits only changed values", async () => {
    const overview = await renderOverview();
    const updates: Array<Record<string, unknown>> = [];
    overview.addEventListener("agent-update", (event) => {
      updates.push((event as CustomEvent<Record<string, unknown>>).detail);
    });

    const save = query<HTMLButtonElement>(overview, ".overview-save");
    expect(save.disabled).toBe(true);

    const name = query<HTMLInputElement>(overview, "#overview-name");
    expect(name.value).toBe("Atlas");
    name.value = "Atlas Prime";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await overview.updateComplete;

    expect(query<HTMLButtonElement>(overview, ".overview-save").disabled).toBe(false);
    query<HTMLButtonElement>(overview, ".overview-save").click();

    expect(updates).toEqual([{ agentId: "atlas", name: "Atlas Prime" }]);
  });

  it("rejects an empty name locally", async () => {
    const overview = await renderOverview();
    const updates: unknown[] = [];
    overview.addEventListener("agent-update", (event) => updates.push(event));

    const name = query<HTMLInputElement>(overview, "#overview-name");
    name.value = "   ";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await overview.updateComplete;
    query<HTMLButtonElement>(overview, ".overview-save").click();
    await overview.updateComplete;

    expect(updates).toHaveLength(0);
    expect(query<HTMLElement>(overview, '[role="alert"]').textContent).toContain(
      "Name cannot be empty",
    );
  });

  it("falls back to read-only guidance when updates are unavailable", async () => {
    const overview = await renderOverview({
      features: { ...features, updateAgent: false },
    });

    expect(overview.querySelector("#overview-name")).toBeNull();
    expect(overview.querySelector(".overview-save")).toBeNull();
    const notice = query<HTMLElement>(overview, '[data-state="read-only"]');
    expect(notice.textContent).toContain("built-in Agents page");
    expect(query<HTMLElement>(overview, '[data-fact="name"]').textContent).toContain("Atlas");
  });

  it("does not offer a save that would send nothing", async () => {
    const overview = await renderOverview();
    const updates: unknown[] = [];
    overview.addEventListener("agent-update", (event) => updates.push(event));

    // agents.update cannot clear a model override, so an emptied field is not a change.
    const model = query<HTMLInputElement>(overview, "#overview-model");
    model.value = "";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    await overview.updateComplete;

    expect(query<HTMLButtonElement>(overview, ".overview-save").disabled).toBe(true);
    query<HTMLButtonElement>(overview, ".overview-save").click();
    expect(updates).toHaveLength(0);
  });

  it("blocks a second submission while one is in flight", async () => {
    const overview = await renderOverview({ saving: true });
    const name = query<HTMLInputElement>(overview, "#overview-name");
    name.value = "Atlas Prime";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await overview.updateComplete;

    expect(query<HTMLButtonElement>(overview, ".overview-save").disabled).toBe(true);
    expect(query<HTMLButtonElement>(overview, ".overview-save").textContent).toContain("Saving");
  });

  it("surfaces a save failure without leaking server text", async () => {
    const overview = await renderOverview({ errorText: "Could not update this agent." });

    expect(query<HTMLElement>(overview, '[role="alert"]').textContent).toContain(
      "Could not update this agent.",
    );
  });
});

describe("directory store agent updates", () => {
  function storeWith(update: (payload: Record<string, unknown>) => Promise<unknown>) {
    return createAgentDirectoryStore({
      api: {
        operation: async (_id: string, operation: string, payload: Record<string, unknown>) => {
          if (operation === "listAgents") {
            return {
              defaultId: "atlas",
              agents: [
                { id: "atlas", name: "Atlas", model: { primary: "opus" }, workspaceGit: true },
                { id: "zephyr", name: "Zephyr" },
              ],
            };
          }
          if (operation === "colors.list") return { colors: {} };
          if (operation === "updateAgent") return await update(payload);
          throw new Error(`unexpected ${operation}`);
        },
      },
      connectionId,
      features,
    });
  }

  it("applies an optimistic rename and rolls it back on failure", async () => {
    let fail = false;
    const store = storeWith(async (payload) => {
      if (fail) throw new Error("rejected");
      return { ok: true, agentId: payload.agentId };
    });
    await store.load();
    expect(store.getState().agents[0].label).toBe("Atlas");

    const pending = store.updateAgent("atlas", { name: "Atlas Prime" });
    expect(store.getState().agents.find((agent) => agent.id === "atlas")?.label).toBe("Atlas Prime");
    await pending;
    expect(store.getState().agents.find((agent) => agent.id === "atlas")?.label).toBe("Atlas Prime");
    expect(store.getState().updateErrorText).toBeUndefined();

    fail = true;
    await store.updateAgent("atlas", { name: "Broken" });
    expect(store.getState().agents.find((agent) => agent.id === "atlas")?.label).toBe("Atlas Prime");
    expect(store.getState().updateErrorText).toBe("Could not update this agent.");
  });
});
