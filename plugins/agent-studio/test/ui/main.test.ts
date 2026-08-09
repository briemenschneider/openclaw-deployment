import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStudioApp, AgentStudioApi } from "../../src/ui/agent-studio-app.js";

const connectionId = "d".repeat(64);
const restoredConnectionId = "e".repeat(64);
const features = {
  listAgents: true,
  updateAgent: false,
  listAgentFiles: true,
  getAgentFile: true,
  setAgentFile: true,
  listModels: true,
  listSessions: true,
  createSession: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type ApiStub = Omit<AgentStudioApi, "operation"> & Partial<Pick<AgentStudioApi, "operation">>;

async function mountMain(api: ApiStub): Promise<AgentStudioApp> {
  document.body.innerHTML = '<div id="agent-studio-root"></div>';
  vi.resetModules();
  await import("../../src/ui/main.js");
  const app = document.querySelector<AgentStudioApp>("agent-studio-app");
  if (!app) throw new Error("main did not mount the app");
  app.api = { operation: async () => ({}), ...api };
  await app.updateComplete;
  return app;
}

function connect(app: AgentStudioApp): void {
  const input = app.querySelector<HTMLInputElement>("#gateway-token");
  const button = app.querySelector<HTMLButtonElement>(".primary-action");
  if (!input || !button) throw new Error("missing connection controls");
  input.value = "ephemeral";
  button.click();
}

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Agent Studio document lifecycle", () => {
  it("clears and disconnects once when pagehide precedes element removal", async () => {
    const disconnect = vi.fn(async () => undefined);
    const app = await mountMain({
      connect: async () => ({ connectionId, features }),
      disconnect,
    });
    connect(app);
    await vi.waitFor(() => expect(app.connectionId).toBe(connectionId));

    window.dispatchEvent(new Event("pagehide"));

    expect(app.connectionId).toBeUndefined();
    expect(app.features).toBeUndefined();
    app.remove();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith(connectionId, { keepalive: true });
  });

  it("cleans a late connect result after pagehide without adopting it", async () => {
    const pending = deferred<{ connectionId: string; features: typeof features }>();
    const disconnect = vi.fn(async () => undefined);
    const app = await mountMain({ connect: () => pending.promise, disconnect });
    connect(app);
    await app.updateComplete;

    window.dispatchEvent(new Event("pagehide"));
    pending.resolve({ connectionId, features });

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith(connectionId, { keepalive: true });
    expect(app.connectionId).toBeUndefined();
    expect(app.features).toBeUndefined();
    app.remove();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("reactivates after pageshow and cleans the restored connection on a second pagehide", async () => {
    let connectCalls = 0;
    const disconnect = vi.fn(async () => undefined);
    const app = await mountMain({
      connect: async () => ({
        connectionId: connectCalls++ === 0 ? connectionId : restoredConnectionId,
        features,
      }),
      disconnect,
    });
    connect(app);
    await vi.waitFor(() => expect(app.connectionId).toBe(connectionId));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("pageshow"));
    await app.updateComplete;
    expect(app.connectionId).toBeUndefined();
    expect(app.features).toBeUndefined();
    connect(app);
    await vi.waitFor(() => expect(app.connectionId).toBe(restoredConnectionId));

    window.dispatchEvent(new Event("pagehide"));

    expect(app.connectionId).toBeUndefined();
    expect(app.features).toBeUndefined();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(2));
    expect(disconnect.mock.calls).toEqual([
      [connectionId, { keepalive: true }],
      [restoredConnectionId, { keepalive: true }],
    ]);
  });

  it("prevents a pre-pagehide late success from overwriting the restored generation", async () => {
    const pending = deferred<{ connectionId: string; features: typeof features }>();
    const staleFeatures = { ...features, listAgents: false };
    let connectCalls = 0;
    const disconnect = vi.fn(async () => undefined);
    const app = await mountMain({
      connect: () => connectCalls++ === 0
        ? pending.promise
        : Promise.resolve({ connectionId: restoredConnectionId, features }),
      disconnect,
    });
    connect(app);
    await app.updateComplete;
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pageshow"));
    await app.updateComplete;

    connect(app);
    await vi.waitFor(() => expect(app.connectionId).toBe(restoredConnectionId));
    pending.resolve({ connectionId, features: staleFeatures });

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith(connectionId, { keepalive: true });
    expect(app.connectionId).toBe(restoredConnectionId);
    expect(app.features).toEqual(features);
  });
});
