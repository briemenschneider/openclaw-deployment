import { afterEach, describe, expect, it } from "vitest";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { startFakeGateway, type FakeGateway } from "./fixtures/fake-gateway.js";

const openFixtures = new Set<FakeGateway>();

afterEach(async () => {
  await Promise.all([...openFixtures].map((fixture) => fixture.stop()));
  openFixtures.clear();
});

describe("pure-plugin transport spike", () => {
  it("sends an opaque-origin text/plain POST without a preflight", async () => {
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);

    await fixture.browserPost("/bridge", {
      body: JSON.stringify({ method: "agents.list" }),
      headers: { "Content-Type": "text/plain" },
    });

    expect(fixture.httpRequests).toEqual([
      {
        method: "POST",
        pathname: "/bridge",
        origin: "null",
        contentType: "text/plain",
      },
    ]);
  });

  it("preflights an Authorization header, rejecting direct iframe gateway auth", async () => {
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);

    await fixture.browserPost("/gateway-auth", {
      body: JSON.stringify({ method: "agents.list" }),
      headers: {
        Authorization: "Bearer supplied-token",
        "Content-Type": "text/plain",
      },
    });

    expect(fixture.httpRequests.map(({ method, pathname }) => ({ method, pathname }))).toEqual([
      { method: "OPTIONS", pathname: "/gateway-auth" },
      { method: "POST", pathname: "/gateway-auth" },
    ]);
  });

  it("authenticates the public GatewayClient and closes valid and invalid sessions", async () => {
    const fixture = await startFakeGateway();
    openFixtures.add(fixture);
    let resolveHello!: (value: unknown) => void;
    let rejectHello!: (error: Error) => void;
    const helloPromise = new Promise<unknown>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });
    const client = new GatewayClient({
      url: fixture.gatewayUrl,
      token: "agent-studio-test-token",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      clientName: "gateway-client",
      mode: "backend",
      deviceIdentity: null,
      onHelloOk: resolveHello,
      onConnectError: rejectHello,
    });

    try {
      client.start();
      await expect(helloPromise).resolves.toMatchObject({
        type: "hello-ok",
        auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
      });
      expect(fixture.connectAttempts[0]).toEqual({
        token: "agent-studio-test-token",
        scopes: ["operator.read", "operator.write"],
      });
      await expect(client.request("agent-studio.echo", { value: "round-trip" })).resolves.toEqual({
        value: "round-trip",
      });

      let resolveInvalid!: (error: Error) => void;
      const invalidError = new Promise<Error>((resolve) => {
        resolveInvalid = resolve;
      });
      const invalidClient = new GatewayClient({
        url: fixture.gatewayUrl,
        token: "invalid-token",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        clientName: "gateway-client",
        mode: "backend",
        deviceIdentity: null,
        hostDeps: { logError: () => undefined },
        onConnectError: resolveInvalid,
      });
      try {
        invalidClient.start();
        await expect(invalidError).resolves.toMatchObject({ message: "invalid token" });
      } finally {
        await invalidClient.stopAndWait();
      }
    } finally {
      await client.stopAndWait();
    }

    await expect.poll(() => fixture.activeConnectionCount()).toBe(0);
  });
});
