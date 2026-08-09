import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopbackGatewayConnection } from "../src/gateway-connection.js";
import { startFakeGateway, type FakeGateway } from "./fixtures/fake-gateway.js";

const openFixtures = new Set<FakeGateway>();
const openConnections = new Set<LoopbackGatewayConnection>();

afterEach(async () => {
  await Promise.all([...openConnections].map((connection) => connection.stopAndWait()));
  openConnections.clear();
  await Promise.all([...openFixtures].map((fixture) => fixture.stop()));
  openFixtures.clear();
});

function connectTo(fixture: FakeGateway, token: string) {
  let resolveHello!: (hello: unknown) => void;
  let rejectHello!: (error: Error) => void;
  const hello = new Promise<unknown>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const closes: Array<{ code: number; reason: string }> = [];
  const connection = new LoopbackGatewayConnection({
    url: fixture.gatewayUrl,
    token,
    scopes: ["operator.read", "operator.write"],
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
    onClose: (code, reason) => closes.push({ code, reason }),
  });
  openConnections.add(connection);
  connection.start();
  return { closes, connection, hello };
}

describe("loopback Gateway connection", () => {
  it("authenticates once and correlates concurrent requests", async () => {
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);
    const { connection, hello } = connectTo(fixture, "agent-studio-test-token");

    await expect(hello).resolves.toMatchObject({ type: "hello-ok" });
    await expect(
      Promise.all([
        connection.request("agent-studio.echo", { value: "first" }),
        connection.request("agent-studio.echo", { value: "second" }),
      ]),
    ).resolves.toEqual([{ value: "first" }, { value: "second" }]);
    expect(fixture.connectAttempts).toEqual([
      {
        token: "agent-studio-test-token",
        scopes: ["operator.read", "operator.write"],
      },
    ]);

    await connection.stopAndWait();
    await expect.poll(() => fixture.activeConnectionCount()).toBe(0);
  });

  it("returns a generic authentication error and cleans up invalid auth", async () => {
    const token = "invalid-token-not-for-errors";
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);
    const { connection, hello } = connectTo(fixture, token);

    const error = await hello.catch((value: unknown) => value);

    expect(error).toMatchObject({ message: "Gateway authentication failed" });
    expect(JSON.stringify(error)).not.toContain(token);
    await connection.stopAndWait();
    await expect.poll(() => fixture.activeConnectionCount()).toBe(0);
  });

  it("rejects pending requests generically and never reconnects after remote close", async () => {
    const token = "agent-studio-test-token";
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);
    const { closes, connection, hello } = connectTo(fixture, token);
    await hello;
    const pending = connection.request("agent-studio.never-responds", {});

    fixture.disconnectGatewayClients();

    const error = await pending.catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "Gateway connection closed" });
    expect(JSON.stringify(error)).not.toContain(token);
    await expect.poll(() => closes).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    expect(fixture.connectAttempts).toHaveLength(1);
    expect(fixture.activeConnectionCount()).toBe(0);
  });

  it("rejects pending requests and clears their timers during shutdown", async () => {
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);
    const { connection, hello } = connectTo(fixture, "agent-studio-test-token");
    await hello;

    vi.useFakeTimers();
    try {
      const pendingResult = connection
        .request("agent-studio.never-responds", {}, { timeoutMs: 60_000 })
        .catch((value: unknown) => value);
      const stopped = connection.stopAndWait();
      await vi.advanceTimersByTimeAsync(1_001);

      await expect(stopped).resolves.toBeUndefined();
      await expect(pendingResult).resolves.toMatchObject({
        message: "Gateway connection stopped",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await expect.poll(() => fixture.activeConnectionCount()).toBe(0);
  });
});
