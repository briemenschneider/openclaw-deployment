import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStudioApiError, createAgentStudioApiClient } from "../../src/ui/api-client.js";
import "../../src/ui/agent-studio-app.js";
import type { AgentStudioApp, AgentStudioApi } from "../../src/ui/agent-studio-app.js";

const connectionId = "a".repeat(64);
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type ApiStub = Omit<AgentStudioApi, "operation"> & Partial<Pick<AgentStudioApi, "operation">>;

async function render(api: ApiStub): Promise<AgentStudioApp> {
  const app = document.createElement("agent-studio-app") as AgentStudioApp;
  app.api = { operation: async () => ({}), ...api };
  document.body.append(app);
  await app.updateComplete;
  return app;
}

function element<T extends Element>(app: AgentStudioApp, selector: string): T {
  const value = app.querySelector<T>(selector);
  if (!value) throw new Error(`missing ${selector}`);
  return value;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Agent Studio authentication", () => {
  it("presents a labelled and masked disconnected screen", async () => {
    const app = await render({ connect: vi.fn(), disconnect: vi.fn() });
    const input = element<HTMLInputElement>(app, "#gateway-token");

    expect(app.textContent).toContain("Connect to your Gateway");
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("current-password");
    expect(element<HTMLLabelElement>(app, 'label[for="gateway-token"]').textContent).toContain(
      "Gateway token",
    );
    expect(element<HTMLElement>(app, '[role="status"]').getAttribute("aria-live")).toBe("polite");
  });

  it("submits on Enter, disables while connecting, and clears the token after settle", async () => {
    const pending = deferred<{ connectionId: string; features: typeof features }>();
    let receivedExpectedToken = false;
    const app = await render({
      connect: (token) => {
        receivedExpectedToken = token === "test-token-that-must-not-persist";
        return pending.promise;
      },
      disconnect: vi.fn(),
    });
    const input = element<HTMLInputElement>(app, "#gateway-token");
    input.value = "test-token-that-must-not-persist";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await app.updateComplete;

    expect(receivedExpectedToken).toBe(true);
    expect(element<HTMLButtonElement>(app, ".primary-action").disabled).toBe(true);
    expect(input.disabled).toBe(true);

    pending.resolve({ connectionId, features });
    await pending.promise;
    await app.updateComplete;

    expect(input.value).toBe("");
    expect(app.innerHTML).not.toContain("test-token-that-must-not-persist");
    expect("token" in app).toBe(false);
    expect("gatewayToken" in app).toBe(false);
    expect(app.connectionId).toBe(connectionId);
    expect(app.features).toEqual(features);
  });

  it("announces a generic failure and supports explicit disconnect", async () => {
    const disconnectCalls: string[] = [];
    let fail = true;
    let connectCalls = 0;
    let receivedWrongSecret = false;
    const connect = async (token: string) => {
      connectCalls += 1;
      receivedWrongSecret = token === "wrong-secret";
      if (fail) throw new AgentStudioApiError("CONNECT_FAILED");
      return { connectionId, features };
    };
    const app = await render({
      connect,
      disconnect: async (id) => {
        disconnectCalls.push(id);
      },
    });
    const input = element<HTMLInputElement>(app, "#gateway-token");
    input.value = "wrong-secret";
    element<HTMLButtonElement>(app, ".primary-action").click();
    await vi.waitFor(() => expect(connectCalls).toBe(1));
    expect(receivedWrongSecret).toBe(true);
    await vi.waitFor(() => expect(input.value).toBe(""));
    await app.updateComplete;
    expect(app.textContent).toContain("Connection failed. Check the token and try again.");
    expect(element<HTMLElement>(app, '[role="alert"]').textContent).toContain("Connection failed");
    expect(app.textContent).not.toContain("wrong-secret");
    expect(input.value).toBe("");

    fail = false;
    input.value = "ephemeral";
    element<HTMLButtonElement>(app, ".primary-action").click();
    await vi.waitFor(() => expect(app.connectionId).toBe(connectionId));
    element<HTMLButtonElement>(app, "#disconnect").click();
    await vi.waitFor(() => expect(app.connectionId).toBeUndefined());

    expect(disconnectCalls).toEqual([connectionId]);
    expect(app.features).toBeUndefined();
    expect(document.activeElement).toBe(element<HTMLInputElement>(app, "#gateway-token"));
  });
});

describe("Agent Studio connection lifecycle", () => {
  it("clears an established connection and disconnects it once when removed", async () => {
    const disconnect = vi.fn(async () => undefined);
    const app = await render({
      connect: async () => ({ connectionId, features }),
      disconnect,
    });
    element<HTMLInputElement>(app, "#gateway-token").value = "ephemeral";
    element<HTMLButtonElement>(app, ".primary-action").click();
    await vi.waitFor(() => expect(app.connectionId).toBe(connectionId));

    app.remove();

    expect(app.connectionId).toBeUndefined();
    expect(app.features).toBeUndefined();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith(connectionId, { keepalive: true });

    document.body.append(app);
    await app.updateComplete;
    expect(app.textContent).toContain("Disconnected. Gateway token required");
  });

  it("cleans a late connection result instead of adopting it after removal", async () => {
    const pending = deferred<{ connectionId: string; features: typeof features }>();
    const disconnect = vi.fn(async () => undefined);
    const app = await render({ connect: () => pending.promise, disconnect });
    element<HTMLInputElement>(app, "#gateway-token").value = "ephemeral";
    element<HTMLButtonElement>(app, ".primary-action").click();
    await app.updateComplete;

    app.remove();
    pending.resolve({ connectionId, features });

    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith(connectionId, { keepalive: true });
    expect(app.connectionId).toBeUndefined();
    expect(app.features).toBeUndefined();
    document.body.append(app);
    await app.updateComplete;
    expect(app.querySelector("#disconnect")).toBeNull();
    expect(app.querySelector("#gateway-token")).not.toBeNull();
  });

  it("ignores a late rejection after removal without detached error state", async () => {
    const pending = deferred<{ connectionId: string; features: typeof features }>();
    const app = await render({ connect: () => pending.promise, disconnect: vi.fn() });
    element<HTMLInputElement>(app, "#gateway-token").value = "ephemeral";
    element<HTMLButtonElement>(app, ".primary-action").click();
    await app.updateComplete;

    app.remove();
    pending.reject(new AgentStudioApiError("CONNECT_FAILED"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();

    expect(app.connectionId).toBeUndefined();
    expect(app.features).toBeUndefined();
    document.body.append(app);
    await app.updateComplete;
    expect(app.querySelector('[role="alert"]')?.textContent).toBe("");
    expect(app.textContent).not.toContain("Connection failed");
  });

  it("keeps explicit disconnect plus removal idempotent", async () => {
    const pendingDisconnect = deferred<void>();
    const disconnect = vi.fn(() => pendingDisconnect.promise);
    const app = await render({
      connect: async () => ({ connectionId, features }),
      disconnect,
    });
    element<HTMLInputElement>(app, "#gateway-token").value = "ephemeral";
    element<HTMLButtonElement>(app, ".primary-action").click();
    await vi.waitFor(() => expect(app.connectionId).toBe(connectionId));

    element<HTMLButtonElement>(app, "#disconnect").click();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    app.remove();
    app.remove();
    expect(disconnect).toHaveBeenCalledTimes(1);

    pendingDisconnect.resolve();
    await pendingDisconnect.promise;
    await Promise.resolve();
    expect(app.connectionId).toBeUndefined();
    expect(app.features).toBeUndefined();
  });
});

describe("Agent Studio API client", () => {
  it("uses exact text/plain POSTs and exposes stable non-leaking errors", async () => {
    let fetchCalls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        expect(url).toBe("./api");
        expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "text/plain" } });
        expect(init?.headers).not.toHaveProperty("Authorization");
        expect(init?.body).toBe(JSON.stringify({ action: "connect", token: "one-use-token" }));
        return new Response(JSON.stringify({ ok: true, connectionId, features }));
      }
      return new Response("private-token at secret.internal", { status: 500 });
    };
    const client = createAgentStudioApiClient(fetcher);

    await expect(client.connect("one-use-token")).resolves.toEqual({ connectionId, features });

    const failure = await client.connect("private-token").catch((error: unknown) => error);
    expect(fetchCalls).toBe(2);
    expect(failure).toMatchObject({ code: "CONNECT_FAILED", message: "Connection failed" });
    expect(String(failure)).not.toContain("private-token");
    expect(String(failure)).not.toContain("secret.internal");
  });

  it("uses a keepalive simple POST for teardown disconnect", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }));
    const client = createAgentStudioApiClient(fetcher);

    await client.disconnect(connectionId, { keepalive: true });

    expect(fetcher).toHaveBeenCalledWith("./api", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "disconnect", connectionId }),
      credentials: "omit",
      keepalive: true,
    });
  });
});
