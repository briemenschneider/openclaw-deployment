import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createPanelRequestBroker,
  deriveGatewayOperationFeatures,
  executeGatewayOperation,
  type GatewayOperationClient,
} from "../src/gateway-operations.js";
import { createAgentStudioHttpHandler } from "../src/http-handler.js";
import {
  PanelSessionBroker,
  type GatewayClientFactory,
  type GatewayClientLike,
} from "../src/panel-sessions.js";

type RequestCall = { method: string; payload: unknown };

function recordingClient(result: unknown = { accepted: true }) {
  const calls: RequestCall[] = [];
  const client: GatewayOperationClient = {
    async request<T>(method: string, payload?: unknown): Promise<T> {
      calls.push({ method, payload });
      if (result instanceof Error) throw result;
      return result as T;
    },
  };
  return { calls, client };
}

const advertised = [
  "agents.list",
  "agent.get",
  "agents.update",
  "agents.files.list",
  "agents.files.get",
  "agents.files.set",
  "models.list",
  "sessions.list",
  "sessions.create",
];

describe("Gateway operation allowlist", () => {
  it("derives browser feature flags only from cached advertised Gateway methods", () => {
    expect(
      deriveGatewayOperationFeatures([
        "agents.list",
        "agents.files.get",
        "sessions.create",
        "config.set",
        "exec.run",
      ]),
    ).toEqual({
      listAgents: true,
      getAgent: false,
      updateAgent: false,
      listAgentFiles: false,
      getAgentFile: true,
      setAgentFile: false,
      listModels: false,
      listSessions: false,
      createSession: true,
    });
  });

  it.each([
    ["listAgents", {}, "agents.list", {}],
    ["getAgent", { agentId: "main" }, "agent.get", { agentId: "main" }],
    [
      "updateAgent",
      { agentId: "main", name: "Main", model: "openai/gpt-5.6" },
      "agents.update",
      { agentId: "main", name: "Main", model: "openai/gpt-5.6" },
    ],
    ["listAgentFiles", { agentId: "main" }, "agents.files.list", { agentId: "main" }],
    [
      "getAgentFile",
      { agentId: "main", name: "SOUL.md" },
      "agents.files.get",
      { agentId: "main", name: "SOUL.md" },
    ],
    [
      "setAgentFile",
      { agentId: "main", name: "SOUL.md", content: "Be helpful." },
      "agents.files.set",
      { agentId: "main", name: "SOUL.md", content: "Be helpful." },
    ],
    ["listModels", { view: "configured" }, "models.list", { view: "configured" }],
    [
      "listSessions",
      { agentId: "main", limit: 25, archived: false },
      "sessions.list",
      { agentId: "main", limit: 25, archived: false },
    ],
    [
      "createSession",
      {
        agentId: "main",
        label: "Review",
        model: "openai/gpt-5.6",
        task: "Review the patch",
        message: "Start now",
        worktree: true,
      },
      "sessions.create",
      {
        agentId: "main",
        label: "Review",
        model: "openai/gpt-5.6",
        task: "Review the patch",
        message: "Start now",
        worktree: true,
      },
    ],
  ] as const)("maps %s independently to the approved Gateway method", async (operation, payload, method, expected) => {
    const { calls, client } = recordingClient();

    await expect(executeGatewayOperation(client, advertised, operation, payload)).resolves.toEqual({
      ok: true,
      data: { accepted: true },
    });
    expect(calls).toEqual([{ method, payload: expected }]);
  });

  it("rejects a valid browser operation when its Gateway method was not advertised", async () => {
    const { calls, client } = recordingClient();

    await expect(executeGatewayOperation(client, ["agents.list"], "createSession", { agentId: "main" })).resolves.toEqual({
      ok: false,
      error: { code: "FEATURE_UNAVAILABLE", message: "Operation unavailable" },
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ["agents.list", {}],
    ["config.set", { path: "gateway.auth.token", value: "stolen" }],
    ["exec.run", { command: "whoami" }],
    ["node.invoke", { command: "system.run" }],
    ["__proto__", {}],
    ["constructor", {}],
    ["listAgents\u0000config.set", {}],
  ])("never forwards malicious or raw operation name %s", async (operation, payload) => {
    const { calls, client } = recordingClient();

    await expect(executeGatewayOperation(client, [...advertised, "config.set", "exec.run", "node.invoke"], operation, payload)).resolves.toEqual({
      ok: false,
      error: { code: "UNSUPPORTED_OPERATION", message: "Unsupported operation" },
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ["listAgents", { extra: true }],
    ["getAgent", { agentId: "" }],
    ["getAgent", { agentId: "main", extra: true }],
    ["updateAgent", { agentId: "main" }],
    ["updateAgent", { agentId: "main", name: 42 }],
    ["updateAgent", { agentId: "main", name: "x".repeat(129) }],
    ["listAgentFiles", { agentId: [] }],
    ["getAgentFile", { agentId: "main", name: "../../.env" }],
    ["setAgentFile", { agentId: "main", name: "SOUL.md", content: 1 }],
    ["setAgentFile", { agentId: "main", name: "SOUL.md", content: "x".repeat(60_001) }],
    ["listModels", { view: "private" }],
    ["listSessions", { limit: 0 }],
    ["listSessions", { limit: 201 }],
    ["listSessions", { offset: -1 }],
    ["listSessions", { activeMinutes: 525_601 }],
    ["listSessions", { includeGlobal: "true" }],
    ["listSessions", { unknown: true }],
    ["createSession", {}],
    ["createSession", { agentId: "main", label: "" }],
    ["createSession", { agentId: "main", message: "x".repeat(32_769) }],
    ["createSession", { agentId: "main", worktree: "yes" }],
    ["createSession", { agentId: "main", key: "agent:other:main" }],
  ])("rejects closed-schema payload for %s before Gateway dispatch", async (operation, payload) => {
    const { calls, client } = recordingClient();

    await expect(executeGatewayOperation(client, advertised, operation, payload)).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_PAYLOAD", message: "Invalid operation payload" },
    });
    expect(calls).toEqual([]);
  });

  it("redacts credential and server-internal fields from successful Gateway responses", async () => {
    const { client } = recordingClient({
      agents: [{ id: "main", name: "Main", token: "gateway-secret" }],
      password: "server-password",
      nested: {
        authorization: "Bearer private",
        visible: true,
        totalTokens: 42,
        stack: "internal stack",
      },
    });

    const result = await executeGatewayOperation(client, advertised, "listAgents", {});

    expect(result).toEqual({
      ok: true,
      data: {
        agents: [{ id: "main", name: "Main" }],
        nested: { visible: true, totalTokens: 42 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/gateway-secret|server-password|Bearer private|internal stack/);
  });

  it("normalizes Gateway failures without credentials, details, causes, or server messages", async () => {
    const failure = Object.assign(new Error("invalid token gateway-secret at C:\\server\\gateway.ts:42"), {
      code: "INVALID_REQUEST",
      details: { credential: "gateway-secret", stack: "server stack" },
      cause: new Error("database unavailable"),
    });
    const { client } = recordingClient(failure);

    const result = await executeGatewayOperation(client, advertised, "listAgents", {});

    expect(result).toEqual({
      ok: false,
      error: { code: "GATEWAY_REQUEST_FAILED", message: "Gateway request failed" },
    });
    expect(JSON.stringify(result)).not.toMatch(/gateway-secret|gateway\.ts|server stack|database unavailable|INVALID_REQUEST/);
  });
});

async function invokeHandler(
  handler: ReturnType<typeof createAgentStudioHttpHandler>,
  requestBody: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const raw = JSON.stringify(requestBody);
  const req = new PassThrough() as PassThrough & IncomingMessage;
  Object.assign(req, {
    method: "POST",
    url: "/plugins/agent-studio/api",
    headers: {
      origin: "null",
      "content-type": "text/plain",
      "content-length": String(Buffer.byteLength(raw)),
    },
    socket: { remoteAddress: "192.0.2.88" },
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0,
    setHeader() {},
    end(body?: string) {
      res.body = body ? JSON.parse(body) : undefined;
      res.emit("finish");
    },
    body: undefined as unknown,
  }) as unknown as EventEmitter & ServerResponse & { body: unknown };

  const handled = handler(req, res);
  req.end(raw);
  await handled;
  return { statusCode: res.statusCode, body: res.body };
}

describe("authenticated handler operation dispatch", () => {
  it("caches hello features, returns them on connect, and dispatches an authenticated operation end-to-end", async () => {
    const requestCalls: RequestCall[] = [];
    let helloMethods = ["agents.list", "sessions.create"];
    const createGatewayClient: GatewayClientFactory = (options) => ({
      start() {
        options.onHelloOk?.({ features: { methods: helloMethods, events: [] } } as never);
      },
      async stopAndWait() {},
      async request<T>(method: string, payload?: unknown): Promise<T> {
        requestCalls.push({ method, payload });
        return { agents: [{ id: "main", name: "Main" }] } as T;
      },
    } satisfies GatewayClientLike);
    const sessions = new PanelSessionBroker({
      gatewayUrl: "ws://127.0.0.1:18789",
      createGatewayClient,
    });
    const handler = createAgentStudioHttpHandler({ broker: createPanelRequestBroker(sessions) });

    try {
      const connected = await sessions.connect("one-use-token", "192.0.2.88");
      expect(connected).toMatchObject({
        ok: true,
        features: {
          listAgents: true,
          createSession: true,
          updateAgent: false,
          listSessions: false,
        },
      });
      if (!connected.ok) throw new Error("expected connection");
      helloMethods = [...advertised, "config.set"];

      const response = await invokeHandler(handler, {
        action: "operation",
        connectionId: connected.connectionId,
        operation: "listAgents",
        payload: {},
      });

      expect(response).toEqual({
        statusCode: 200,
        body: { ok: true, data: { agents: [{ id: "main", name: "Main" }] } },
      });
      expect(requestCalls).toEqual([{ method: "agents.list", payload: {} }]);

      const notCached = await invokeHandler(handler, {
        action: "operation",
        connectionId: connected.connectionId,
        operation: "updateAgent",
        payload: { agentId: "main", name: "Changed" },
      });
      expect(notCached.body).toEqual({
        ok: false,
        error: { code: "FEATURE_UNAVAILABLE", message: "Operation unavailable" },
      });
      expect(requestCalls).toHaveLength(1);
    } finally {
      await sessions.shutdown();
    }
  });
});
