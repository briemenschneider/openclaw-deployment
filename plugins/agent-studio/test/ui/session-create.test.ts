import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStudioApiError, type AgentStudioFeatures } from "../../src/ui/api-client.js";
import {
  createSessionController,
  type SessionCreateState,
  type SessionController,
} from "../../src/ui/session-create.js";
import "../../src/ui/session-create.js";
import type { SessionCreate } from "../../src/ui/session-create.js";
import "../../src/ui/agent-studio-app.js";
import type { AgentStudioApp } from "../../src/ui/agent-studio-app.js";

const connectionId = "1".repeat(64);

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

function controllerWith(handlers: Handlers, calls: Call[] = [], overrides = {}): SessionController {
  return createSessionController({
    api: stubApi(handlers, calls),
    connectionId,
    features,
    ...overrides,
  });
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`missing ${selector}`);
  return value;
}

async function renderCreate(properties: Partial<SessionCreate> = {}): Promise<SessionCreate> {
  const element = document.createElement("session-create") as SessionCreate;
  element.agentId = "atlas";
  element.features = features;
  element.state = { status: "idle", advancedOpen: false } satisfies SessionCreateState;
  Object.assign(element, properties);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("session controller", () => {
  it("creates a session for the given agent and exposes the returned key", async () => {
    const calls: Call[] = [];
    const controller = controllerWith(
      { createSession: async () => ({ ok: true, key: "atlas:2026-08-09" }) },
      calls,
    );

    const pending = controller.create("atlas", {});
    expect(controller.getState().status).toBe("creating");
    await pending;

    expect(calls).toEqual([{ operation: "createSession", payload: { agentId: "atlas" } }]);
    expect(controller.getState()).toMatchObject({
      status: "created",
      key: "atlas:2026-08-09",
      agentId: "atlas",
    });
  });

  it("sends only the advanced fields the operator filled in", async () => {
    const calls: Call[] = [];
    const controller = controllerWith({ createSession: async () => ({ key: "k" }) }, calls);

    await controller.create("zephyr", {
      label: " nightly ",
      model: "",
      task: "run the audit",
      worktree: true,
    });

    expect(calls.at(-1)?.payload).toEqual({
      agentId: "zephyr",
      label: "nightly",
      task: "run the audit",
      worktree: true,
    });
  });

  it("rejects invalid fields locally without calling the Gateway", async () => {
    const calls: Call[] = [];
    const controller = controllerWith({ createSession: async () => ({ key: "k" }) }, calls);

    await controller.create("atlas", { label: "x".repeat(257) });
    expect(calls).toHaveLength(0);
    expect(controller.getState()).toMatchObject({
      status: "error",
      errorText: "Label must be 256 characters or fewer.",
    });

    await controller.create("atlas", { task: "y".repeat(32_769) });
    expect(calls).toHaveLength(0);
    expect(controller.getState().errorText).toBe(
      "Task must be 32,768 characters or fewer.",
    );

    await controller.create("not a valid id!", {});
    expect(calls).toHaveLength(0);
    expect(controller.getState().errorText).toBe("Select an agent before creating a session.");
  });

  it("ignores a second submission while one is in flight", async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = controllerWith(
      {
        createSession: async () => {
          await gate;
          return { key: "only-one" };
        },
      },
      calls,
    );

    const first = controller.create("atlas", {});
    await controller.create("atlas", {});
    expect(calls).toHaveLength(1);

    release();
    await first;
    expect(calls).toHaveLength(1);
    expect(controller.getState().key).toBe("only-one");
  });

  it("reports a failure without leaking server text and keeps the form usable", async () => {
    const controller = controllerWith({
      createSession: async () => {
        throw new AgentStudioApiError("OPERATION_FAILED");
      },
      listSessions: async () => ({ sessions: [] }),
    });

    await controller.create("atlas", { label: "nightly" });

    expect(controller.getState()).toMatchObject({
      status: "error",
      errorText: "Could not create the session. Check the fields and try again.",
    });
    expect(controller.getState().key).toBeUndefined();
  });

  it("adopts a session that was created despite a lost response", async () => {
    const calls: Call[] = [];
    const controller = controllerWith(
      {
        createSession: async () => {
          throw new AgentStudioApiError("OPERATION_FAILED");
        },
        listSessions: async () => ({
          sessions: [
            { key: "zephyr:1", agentId: "zephyr", label: "nightly" },
            { key: "atlas:9", agentId: "atlas", label: "nightly" },
          ],
        }),
      },
      calls,
    );

    await controller.create("atlas", { label: "nightly" });

    expect(calls.map((call) => call.operation)).toEqual(["createSession", "listSessions"]);
    expect(calls.at(-1)?.payload).toMatchObject({ agentId: "atlas" });
    expect(controller.getState()).toMatchObject({ status: "created", key: "atlas:9" });
  });

  it("does not guess a match when no label distinguishes the session", async () => {
    const controller = controllerWith({
      createSession: async () => {
        throw new AgentStudioApiError("OPERATION_FAILED");
      },
      listSessions: async () => ({ sessions: [{ key: "atlas:9", agentId: "atlas" }] }),
    });

    await controller.create("atlas", {});

    expect(controller.getState().status).toBe("error");
    expect(controller.getState().key).toBeUndefined();
  });

  it("refuses to create when the Gateway does not advertise session creation", async () => {
    const calls: Call[] = [];
    const controller = controllerWith(
      { createSession: async () => ({ key: "k" }) },
      calls,
      { features: { ...features, createSession: false } },
    );

    await controller.create("atlas", {});

    expect(calls).toHaveLength(0);
    expect(controller.getState().errorText).toBe(
      "This Gateway does not expose session creation.",
    );
  });
});

describe("session create component", () => {
  it("sends the current agent id, never a stale one", async () => {
    const element = await renderCreate();
    const requests: Array<Record<string, unknown>> = [];
    element.addEventListener("session-create", (event) => {
      requests.push((event as CustomEvent<Record<string, unknown>>).detail);
    });

    query<HTMLButtonElement>(element, ".session-new").click();
    expect(requests).toEqual([{ agentId: "atlas", options: {} }]);

    query<HTMLButtonElement>(element, ".session-advanced").click();
    await element.updateComplete;
    element.agentId = "zephyr";
    await element.updateComplete;
    query<HTMLButtonElement>(element, ".session-submit").click();

    expect(requests.at(-1)).toMatchObject({ agentId: "zephyr" });
  });

  it("collects the advanced fields and keeps the dialog open on failure", async () => {
    const element = await renderCreate();
    const requests: Array<Record<string, unknown>> = [];
    element.addEventListener("session-create", (event) => {
      requests.push((event as CustomEvent<Record<string, unknown>>).detail);
    });

    query<HTMLButtonElement>(element, ".session-advanced").click();
    await element.updateComplete;
    const dialog = query<HTMLElement>(element, ".session-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");

    query<HTMLInputElement>(dialog, "#session-label").value = "nightly";
    query<HTMLInputElement>(dialog, "#session-model").value = "opus";
    query<HTMLTextAreaElement>(dialog, "#session-task").value = "run the audit";
    query<HTMLInputElement>(dialog, "#session-worktree").checked = true;
    query<HTMLButtonElement>(element, ".session-submit").click();

    expect(requests.at(-1)).toEqual({
      agentId: "atlas",
      options: { label: "nightly", model: "opus", task: "run the audit", worktree: true },
    });

    element.state = {
      status: "error",
      advancedOpen: true,
      errorText: "Could not create the session. Check the fields and try again.",
    };
    await element.updateComplete;
    expect(element.querySelector(".session-dialog")).not.toBeNull();
    expect(query<HTMLElement>(element, '[role="alert"]').textContent).toContain(
      "Could not create the session",
    );
  });

  it("shows the created key with a copy action and Sessions-list guidance", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const element = await renderCreate({
      state: { status: "created", advancedOpen: false, key: "atlas:2026-08-09", agentId: "atlas" },
    });

    expect(query<HTMLElement>(element, ".session-key").textContent).toContain("atlas:2026-08-09");
    expect(element.textContent).toContain("Sessions list");

    query<HTMLButtonElement>(element, ".session-copy").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("atlas:2026-08-09"));
  });

  it("disables creation when the Gateway cannot create sessions", async () => {
    const element = await renderCreate({ features: { ...features, createSession: false } });

    expect(element.querySelector(".session-new")).toBeNull();
    expect(query<HTMLElement>(element, '[data-state="unavailable"]').textContent).toContain(
      "does not expose session creation",
    );
  });

  it("never reaches outside its own frame", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile("src/ui/session-create.ts", "utf8"));

    expect(source).not.toContain("window.parent");
    expect(source).not.toContain("window.top");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("location.assign");
  });
});

describe("Agent Studio session integration", () => {
  it("creates a session for the visibly selected agent", async () => {
    const calls: Call[] = [];
    const api = stubApi(
      {
        listAgents: async () => ({
          defaultId: "atlas",
          agents: [{ id: "atlas", name: "Atlas" }, { id: "zephyr", name: "Zephyr" }],
        }),
        "colors.list": async () => ({ colors: {} }),
        createSession: async (payload) => ({ ok: true, key: `${String(payload.agentId)}:new` }),
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

    query<HTMLButtonElement>(app, '.agent-row[data-agent-id="zephyr"] .agent-select').click();
    await app.updateComplete;
    query<HTMLButtonElement>(app, ".session-new").click();

    await vi.waitFor(() =>
      expect(calls.some((call) => call.operation === "createSession")).toBe(true));
    expect(calls.at(-1)?.payload).toEqual({ agentId: "zephyr" });
    await vi.waitFor(() =>
      expect(app.querySelector(".session-key")?.textContent).toContain("zephyr:new"));
  });
});
