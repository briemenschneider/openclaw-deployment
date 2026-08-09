import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PanelSessionBroker,
  type GatewayClientFactory,
  type GatewayClientLike,
} from "../src/panel-sessions.js";
import { startFakeGateway, type FakeGateway } from "./fixtures/fake-gateway.js";

const openFixtures = new Set<FakeGateway>();
const openBrokers = new Set<PanelSessionBroker>();

type ControlledClient = GatewayClientLike & {
  active: boolean;
  stopCount: number;
  hello(): void;
  close(): void;
};

function controlledFactory(mode: "hello" | "error" | "manual" = "hello") {
  const clients: ControlledClient[] = [];
  const optionsSeen: Parameters<GatewayClientFactory>[0][] = [];
  const createGatewayClient: GatewayClientFactory = (options) => {
    optionsSeen.push(options);
    const client: ControlledClient = {
      active: false,
      stopCount: 0,
      start() {
        client.active = true;
        if (mode === "hello") client.hello();
        if (mode === "error") options.onConnectError?.(new Error("credential rejected"));
      },
      async stopAndWait() {
        client.active = false;
        client.stopCount += 1;
      },
      async request<T>() {
        return {} as T;
      },
      hello() {
        options.onHelloOk?.({ features: { methods: [], events: [] } } as never);
      },
      close() {
        client.active = false;
        options.onClose?.(1006, "gateway closed");
      },
    };
    clients.push(client);
    return client;
  };
  return { clients, createGatewayClient, optionsSeen };
}

afterEach(async () => {
  await Promise.all([...openBrokers].map((broker) => broker.shutdown()));
  openBrokers.clear();
  await Promise.all([...openFixtures].map((fixture) => fixture.stop()));
  openFixtures.clear();
  vi.useRealTimers();
});

describe("panel session broker", () => {
  it("authenticates through the public loopback GatewayClient and returns an opaque 256-bit id", async () => {
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);
    const logs: unknown[] = [];
    const broker = new PanelSessionBroker({
      gatewayUrl: fixture.gatewayUrl,
      log: (event) => logs.push(event),
    });
    openBrokers.add(broker);

    const response = await broker.connect("agent-studio-test-token", "192.0.2.10");

    expect(response).toEqual({
      ok: true,
      connectionId: expect.stringMatching(/^[0-9a-f]{64}$/),
      features: {
        listAgents: false,
        updateAgent: false,
        listAgentFiles: false,
        getAgentFile: false,
        setAgentFile: false,
        listModels: false,
        listSessions: false,
        createSession: false,
      },
    });
    if (!response.ok) throw new Error("expected connection");
    expect(fixture.connectAttempts).toEqual([
      {
        token: "agent-studio-test-token",
        scopes: ["operator.read", "operator.write"],
      },
    ]);
    expect(broker.snapshot()).toMatchObject({ activeConnections: 1 });
    expect(JSON.stringify(response)).not.toContain("agent-studio-test-token");
    expect(JSON.stringify(broker.snapshot())).not.toContain("agent-studio-test-token");
    expect(JSON.stringify(logs)).not.toContain("agent-studio-test-token");
    expect(logs).toEqual([{ action: "connect", connectionId: response.connectionId }]);

    await broker.shutdown();
    openBrokers.delete(broker);
    await expect.poll(() => fixture.activeConnectionCount()).toBe(0);
    expect(broker.snapshot()).toEqual({ activeConnections: 0 });
  });

  it("stops the public GatewayClient on remote close before its reconnect timer fires", async () => {
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);
    const broker = new PanelSessionBroker({ gatewayUrl: fixture.gatewayUrl });
    openBrokers.add(broker);
    const response = await broker.connect("agent-studio-test-token", "192.0.2.11");
    if (!response.ok) throw new Error("expected connection");

    fixture.disconnectGatewayClients();
    await expect.poll(() => broker.snapshot().activeConnections).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 1_250));

    expect(fixture.connectAttempts).toHaveLength(1);
    expect(fixture.activeConnectionCount()).toBe(0);
  });

  it("sanitizes authentication failures, clears the credential reference, and closes the client", async () => {
    const token = "supplied-token-that-must-not-leak";
    const logs: unknown[] = [];
    let stopped = 0;
    let retainedOptions: Parameters<GatewayClientFactory>[0] | undefined;
    const createGatewayClient: GatewayClientFactory = (options) => {
      retainedOptions = options;
      return {
        start() {
          options.onConnectError?.(new Error(`invalid credential: ${token}`));
        },
        async stopAndWait() {
          stopped += 1;
        },
        async request<T>() {
          return {} as T;
        },
      } satisfies GatewayClientLike;
    };
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient,
      log: (event) => logs.push(event),
    });
    openBrokers.add(broker);

    const response = await broker.connect(token, "192.0.2.20");

    expect(response).toEqual({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED", message: "Authentication failed" },
    });
    expect(retainedOptions?.token).toBeUndefined();
    expect(stopped).toBe(1);
    expect(broker.snapshot()).toEqual({ activeConnections: 0 });
    expect(logs).toEqual([{ action: "connect" }]);
    expect(JSON.stringify({ response, snapshot: broker.snapshot(), logs })).not.toContain(token);
  });

  it("clears successful credential references before registration and logging", async () => {
    const token = "success-token-that-must-be-cleared";
    const controlled = controlledFactory();
    let tokenAtSuccessLog: string | undefined;
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
      log: (event) => {
        if ("connectionId" in event && event.action === "connect") {
          tokenAtSuccessLog = controlled.optionsSeen[0]?.token;
        }
      },
    });
    openBrokers.add(broker);

    await expect(broker.connect(token, "192.0.2.21")).resolves.toMatchObject({ ok: true });

    expect(tokenAtSuccessLog).toBeUndefined();
    expect(controlled.optionsSeen[0]?.token).toBeUndefined();
  });

  it("isolates a throwing success logger without orphaning the registered session", async () => {
    vi.useFakeTimers({ now: 0 });
    const controlled = controlledFactory();
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
      log: () => {
        throw new Error("logger failed");
      },
    });
    openBrokers.add(broker);

    const response = await broker.connect("token", "192.0.2.22");

    expect(response).toMatchObject({ ok: true });
    expect(broker.snapshot()).toEqual({ activeConnections: 1 });
    await broker.shutdown();
    expect(controlled.clients[0]).toMatchObject({ active: false, stopCount: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops the client when the disconnect logger throws", async () => {
    vi.useFakeTimers({ now: 0 });
    const controlled = controlledFactory();
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
      log: (event) => {
        if (event.action === "disconnect") throw new Error("logger failed");
      },
    });
    openBrokers.add(broker);
    const response = await broker.connect("token", "192.0.2.23");
    if (!response.ok) throw new Error("expected connection");

    await expect(broker.disconnect(response.connectionId)).resolves.toEqual({ ok: true });

    expect(controlled.clients[0]).toMatchObject({ active: false, stopCount: 1 });
    expect(broker.snapshot()).toEqual({ activeConnections: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("slides the 15-minute idle deadline on authenticated use and expires without live handles", async () => {
    vi.useFakeTimers({ now: 0 });
    const controlled = controlledFactory();
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
    });
    openBrokers.add(broker);
    const response = await broker.connect("token", "192.0.2.30");
    if (!response.ok) throw new Error("expected connection");

    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(broker.getClient(response.connectionId)).toBe(controlled.clients[0]);
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(broker.snapshot()).toEqual({ activeConnections: 1 });
    await vi.advanceTimersByTimeAsync(1);

    expect(broker.getClient(response.connectionId)).toBeUndefined();
    expect(controlled.clients[0]).toMatchObject({ active: false, stopCount: 1 });
    expect(broker.snapshot()).toEqual({ activeConnections: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up timers and sockets on disconnect, Gateway close, and plugin shutdown", async () => {
    vi.useFakeTimers({ now: 0 });
    const controlled = controlledFactory();
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
    });
    openBrokers.add(broker);
    const first = await broker.connect("one", "192.0.2.31");
    const second = await broker.connect("two", "192.0.2.32");
    const third = await broker.connect("three", "192.0.2.33");
    if (!first.ok || !second.ok || !third.ok) throw new Error("expected connections");

    await expect(broker.disconnect(first.connectionId)).resolves.toEqual({ ok: true });
    controlled.clients[1].close();
    expect(broker.snapshot()).toEqual({ activeConnections: 1 });
    await broker.shutdown();

    expect(controlled.clients.map(({ active }) => active)).toEqual([false, false, false]);
    expect(controlled.clients.map(({ stopCount }) => stopCount)).toEqual([1, 1, 1]);
    expect(broker.snapshot()).toEqual({ activeConnections: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reserves pending handshakes against injectable global and per-IP caps", async () => {
    const controlled = controlledFactory("manual");
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
      limits: { globalConnections: 1, perIpConnections: 1 },
    });
    openBrokers.add(broker);

    const pending = broker.connect("one", "192.0.2.40");
    await Promise.resolve();
    await expect(broker.connect("two", "192.0.2.41")).resolves.toEqual({
      ok: false,
      error: { code: "CONNECTION_LIMIT", message: "Connection limit reached" },
    });
    expect(controlled.clients).toHaveLength(1);
    controlled.clients[0].hello();
    await expect(pending).resolves.toMatchObject({ ok: true });
  });

  it("enforces the default four-per-IP and 32-global live-connection caps", async () => {
    const perIp = controlledFactory();
    const perIpBroker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: perIp.createGatewayClient,
    });
    openBrokers.add(perIpBroker);
    for (let index = 0; index < 4; index += 1) {
      await expect(perIpBroker.connect(`token-${index}`, "192.0.2.45")).resolves.toMatchObject({
        ok: true,
      });
    }
    await expect(perIpBroker.connect("fifth", "192.0.2.45")).resolves.toMatchObject({
      ok: false,
      error: { code: "CONNECTION_LIMIT" },
    });
    await expect(perIpBroker.connect("other-ip", "192.0.2.46")).resolves.toMatchObject({
      ok: true,
    });

    const global = controlledFactory();
    const globalBroker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: global.createGatewayClient,
    });
    openBrokers.add(globalBroker);
    for (let index = 0; index < 32; index += 1) {
      await expect(
        globalBroker.connect(`token-${index}`, `198.51.100.${index + 1}`),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(globalBroker.connect("overflow", "203.0.113.1")).resolves.toMatchObject({
      ok: false,
      error: { code: "CONNECTION_LIMIT" },
    });
    expect(global.clients).toHaveLength(32);
  });

  it("limits each source to five connection attempts per rolling minute", async () => {
    vi.useFakeTimers({ now: 0 });
    const controlled = controlledFactory("error");
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
    });
    openBrokers.add(broker);

    for (let index = 0; index < 5; index += 1) {
      await expect(broker.connect(`bad-${index}`, "192.0.2.50")).resolves.toMatchObject({
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      });
    }
    await expect(broker.connect("bad-six", "192.0.2.50")).resolves.toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many connection attempts" },
    });
    expect(controlled.clients).toHaveLength(5);

    await vi.advanceTimersByTimeAsync(60_000);
    await broker.connect("bad-seven", "192.0.2.50");
    expect(controlled.clients).toHaveLength(6);
  });

  it("times out a stalled handshake and stops its socket without retaining a timer", async () => {
    vi.useFakeTimers({ now: 0 });
    const controlled = controlledFactory("manual");
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
      connectTimeoutMs: 1_000,
    });
    openBrokers.add(broker);

    const pending = broker.connect("token", "192.0.2.60");
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED", message: "Authentication failed" },
    });
    expect(controlled.clients[0]).toMatchObject({ active: false, stopCount: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending handshake during plugin shutdown without leaking its timeout", async () => {
    vi.useFakeTimers({ now: 0 });
    const controlled = controlledFactory("manual");
    const broker = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient: controlled.createGatewayClient,
    });
    openBrokers.add(broker);

    const pending = broker.connect("token", "192.0.2.61");
    await Promise.resolve();
    await broker.shutdown();

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(controlled.clients[0]).toMatchObject({ active: false, stopCount: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects non-loopback Gateway URLs before a client can be created", () => {
    const controlled = controlledFactory();
    expect(
      () =>
        new PanelSessionBroker({
          gatewayUrl: "ws://gateway.example.test:18789",
          createGatewayClient: controlled.createGatewayClient,
        }),
    ).toThrow("Gateway URL must use loopback WebSocket transport");
    expect(controlled.clients).toHaveLength(0);
  });
});
