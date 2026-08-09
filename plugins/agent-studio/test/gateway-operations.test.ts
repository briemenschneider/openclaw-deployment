import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  BROWSER_OPERATIONS,
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

    await expect(executeGatewayOperation(client, advertised, operation, payload)).resolves.toMatchObject({
      ok: true,
    });
    expect(calls).toEqual([{ method, payload: expected }]);
  });

  it("has no browser detail RPC even when nonexistent detail method names are advertised", async () => {
    const inventedMethods = ["agent.get", "agents.get", "agent.identity.get"];
    const features = deriveGatewayOperationFeatures(["agents.list", ...inventedMethods]);
    const { calls, client } = recordingClient();

    expect(BROWSER_OPERATIONS).toEqual([
      "listAgents",
      "updateAgent",
      "listAgentFiles",
      "getAgentFile",
      "setAgentFile",
      "listModels",
      "listSessions",
      "createSession",
    ]);
    expect(features).toEqual({
      listAgents: true,
      updateAgent: false,
      listAgentFiles: false,
      getAgentFile: false,
      setAgentFile: false,
      listModels: false,
      listSessions: false,
      createSession: false,
    });

    await expect(
      executeGatewayOperation(client, inventedMethods, "getAgent", { agentId: "main" }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "UNSUPPORTED_OPERATION", message: "Unsupported operation" },
    });
    expect(calls).toEqual([]);
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
    ["agent.get", { agentId: "main" }],
    ["agents.get", { agentId: "main" }],
    ["agent.identity.get", { agentId: "main" }],
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

  it.each([
    {
      operation: "listAgents",
      payload: {},
      gateway: {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "global",
        workspace: "C:\\secret\\agents",
        path: "C:\\secret\\agents.json",
        filePath: "C:\\secret\\config.json",
        entry: { token: "entry-secret" },
        worktree: { path: "C:\\secret\\tree" },
        token: "gateway-secret",
        unknown: "drop-me",
        nested: { secret: "nested-secret" },
        agents: [
          {
            id: "main",
            name: "Main",
            workspace: "C:\\secret\\main",
            workspaceGit: true,
            identity: {
              name: "Main Agent",
              theme: "dark",
              emoji: "🦀",
              avatar: "avatar.png",
              avatarUrl: "https://example.test/avatar.png",
              token: "identity-secret",
              unknown: true,
            },
            model: {
              primary: "openai/gpt-5.6",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
              token: "model-secret",
            },
            token: "agent-secret",
            unknown: true,
          },
        ],
      },
      expected: {
        defaultId: "main",
        agents: [
          {
            id: "main",
            name: "Main",
            workspaceGit: true,
            identity: {
              name: "Main Agent",
              theme: "dark",
              emoji: "🦀",
              avatar: "avatar.png",
              avatarUrl: "https://example.test/avatar.png",
            },
            model: {
              primary: "openai/gpt-5.6",
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
        ],
      },
    },
    {
      operation: "updateAgent",
      payload: { agentId: "main", name: "Main" },
      gateway: {
        ok: true,
        agentId: "main",
        workspace: "C:\\secret\\main",
        path: "C:\\secret\\agents.json",
        filePath: "C:\\secret\\config.json",
        entry: { token: "entry-secret" },
        worktree: { path: "C:\\secret\\tree" },
        token: "gateway-secret",
        unknown: true,
        nested: { secret: "nested-secret" },
      },
      expected: { ok: true, agentId: "main" },
    },
    {
      operation: "listAgentFiles",
      payload: { agentId: "main" },
      gateway: {
        agentId: "main",
        workspace: "C:\\secret\\main",
        path: "C:\\secret\\root",
        filePath: "C:\\secret\\index.json",
        entry: { token: "entry-secret" },
        worktree: { path: "C:\\secret\\tree" },
        token: "gateway-secret",
        unknown: true,
        nested: { secret: "nested-secret" },
        files: [
          {
            name: "SOUL.md",
            path: "C:\\secret\\main\\SOUL.md",
            filePath: "C:\\secret\\main\\SOUL.md",
            missing: false,
            size: 12,
            updatedAtMs: 123,
            content: "not needed in list",
            token: "file-secret",
            unknown: true,
          },
        ],
      },
      expected: {
        agentId: "main",
        files: [{ name: "SOUL.md", missing: false, size: 12, updatedAtMs: 123 }],
      },
    },
    {
      operation: "getAgentFile",
      payload: { agentId: "main", name: "SOUL.md" },
      gateway: {
        agentId: "main",
        workspace: "C:\\secret\\main",
        path: "C:\\secret\\root",
        filePath: "C:\\secret\\index.json",
        entry: { token: "entry-secret" },
        worktree: { path: "C:\\secret\\tree" },
        token: "gateway-secret",
        unknown: true,
        nested: { secret: "nested-secret" },
        file: {
          name: "SOUL.md",
          path: "C:\\secret\\main\\SOUL.md",
          filePath: "C:\\secret\\main\\SOUL.md",
          missing: false,
          size: 12,
          updatedAtMs: 123,
          content: "Be helpful.",
          token: "file-secret",
          unknown: true,
        },
      },
      expected: {
        agentId: "main",
        file: {
          name: "SOUL.md",
          missing: false,
          size: 12,
          updatedAtMs: 123,
          content: "Be helpful.",
        },
      },
    },
    {
      operation: "setAgentFile",
      payload: { agentId: "main", name: "SOUL.md", content: "Be helpful." },
      gateway: {
        ok: true,
        agentId: "main",
        workspace: "C:\\secret\\main",
        path: "C:\\secret\\root",
        filePath: "C:\\secret\\index.json",
        entry: { token: "entry-secret" },
        worktree: { path: "C:\\secret\\tree" },
        token: "gateway-secret",
        unknown: true,
        nested: { secret: "nested-secret" },
        file: {
          name: "SOUL.md",
          path: "C:\\secret\\main\\SOUL.md",
          filePath: "C:\\secret\\main\\SOUL.md",
          missing: false,
          size: 12,
          updatedAtMs: 123,
          content: "Be helpful.",
          token: "file-secret",
          unknown: true,
        },
      },
      expected: {
        ok: true,
        agentId: "main",
        file: {
          name: "SOUL.md",
          missing: false,
          size: 12,
          updatedAtMs: 123,
          content: "Be helpful.",
        },
      },
    },
    {
      operation: "listModels",
      payload: { view: "configured" },
      gateway: {
        workspace: "C:\\secret\\models",
        path: "C:\\secret\\models.json",
        filePath: "C:\\secret\\provider.json",
        entry: { token: "entry-secret" },
        worktree: { path: "C:\\secret\\tree" },
        token: "gateway-secret",
        unknown: true,
        nested: { secret: "nested-secret" },
        models: [
          {
            id: "openai/gpt-5.6",
            name: "GPT-5.6",
            provider: "openai",
            alias: "gpt",
            available: true,
            contextWindow: 200_000,
            reasoning: true,
            token: "model-secret",
            unknown: true,
          },
        ],
      },
      expected: {
        models: [
          {
            id: "openai/gpt-5.6",
            name: "GPT-5.6",
            provider: "openai",
            alias: "gpt",
            available: true,
            contextWindow: 200_000,
            reasoning: true,
          },
        ],
      },
    },
    {
      operation: "listSessions",
      payload: { agentId: "main", limit: 25 },
      gateway: {
        ts: 999,
        path: "C:\\secret\\sessions.json",
        workspace: "C:\\secret\\main",
        filePath: "C:\\secret\\session.json",
        entry: { token: "entry-secret" },
        worktree: { path: "C:\\secret\\tree" },
        token: "gateway-secret",
        unknown: true,
        nested: { secret: "nested-secret" },
        count: 1,
        totalCount: 3,
        limitApplied: 25,
        offset: 0,
        nextOffset: 1,
        hasMore: true,
        defaults: { token: "defaults-secret" },
        sessions: [
          {
            agentId: "main",
            key: "agent:main:review",
            sessionId: "session-1",
            kind: "direct",
            label: "Review",
            displayName: "Review",
            updatedAt: 123,
            archived: false,
            pinned: true,
            unread: false,
            status: "ok",
            hasActiveRun: false,
            startedAt: 100,
            endedAt: 120,
            modelProvider: "openai",
            model: "gpt-5.6",
            totalTokens: 42,
            workspace: "C:\\secret\\session",
            path: "C:\\secret\\transcript.jsonl",
            filePath: "C:\\secret\\transcript.jsonl",
            entry: { token: "row-entry-secret" },
            worktree: { path: "C:\\secret\\tree" },
            token: "row-secret",
            unknown: true,
            nested: { secret: "row-nested-secret" },
            deliveryContext: { token: "delivery-secret" },
            activeRunIds: ["private-run-id"],
          },
        ],
      },
      expected: {
        count: 1,
        totalCount: 3,
        limitApplied: 25,
        offset: 0,
        nextOffset: 1,
        hasMore: true,
        sessions: [
          {
            agentId: "main",
            key: "agent:main:review",
            sessionId: "session-1",
            kind: "direct",
            label: "Review",
            displayName: "Review",
            updatedAt: 123,
            archived: false,
            pinned: true,
            unread: false,
            status: "ok",
            hasActiveRun: false,
            startedAt: 100,
            endedAt: 120,
            modelProvider: "openai",
            model: "gpt-5.6",
            totalTokens: 42,
          },
        ],
      },
    },
    {
      operation: "createSession",
      payload: { agentId: "main", worktree: true },
      gateway: {
        ok: true,
        key: "agent:main:new",
        sessionId: "session-new",
        runStarted: true,
        status: "started",
        workspace: "C:\\secret\\session",
        path: "C:\\secret\\transcript.jsonl",
        filePath: "C:\\secret\\transcript.jsonl",
        entry: { token: "entry-secret", message: "private prompt" },
        worktree: { id: "tree-1", path: "C:\\secret\\tree", branch: "private" },
        token: "gateway-secret",
        unknown: true,
        nested: { secret: "nested-secret" },
      },
      expected: {
        ok: true,
        key: "agent:main:new",
        sessionId: "session-new",
        runStarted: true,
        status: "started",
      },
    },
  ] as const)("positively projects the closed $operation success response", async ({ operation, payload, gateway, expected }) => {
    const { client } = recordingClient(gateway);

    const result = await executeGatewayOperation(client, advertised, operation, payload);

    expect(result).toEqual({ ok: true, data: expected });
    expect(JSON.stringify(result)).not.toMatch(
      /C:\\\\secret|entry-secret|gateway-secret|nested-secret|private prompt|private-run-id/,
    );
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
