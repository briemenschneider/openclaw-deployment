import { accessSync, constants } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentStudioHttpHandler,
  type PanelRequestBroker,
} from "../src/http-handler.js";

type ResponseSnapshot = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

const connectionId = "a".repeat(64);
const openServers = new Set<Server>();
let assetsRoot: string;

type BrowserFrame = {
  evaluate<T>(expression: string): Promise<T>;
  url(): string;
};

type BrowserPage = {
  close(): Promise<void>;
  frames(): BrowserFrame[];
  goto(url: string, options?: { waitUntil: "domcontentloaded" }): Promise<unknown>;
};

type Browser = {
  close(): Promise<void>;
  newPage(): Promise<BrowserPage>;
};

type PlaywrightCore = {
  chromium: {
    launch(options: { executablePath: string; headless: boolean }): Promise<Browser>;
  };
};

const require = createRequire(import.meta.url);
const requireFromOpenClaw = createRequire(require.resolve("openclaw/plugin-sdk/gateway-runtime"));
const { chromium } = requireFromOpenClaw("playwright-core") as PlaywrightCore;
const browserExecutable = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((candidate) => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

beforeEach(async () => {
  assetsRoot = await mkdtemp(join(tmpdir(), "agent-studio-http-"));
  await writeFile(
    join(assetsRoot, "index.html"),
    '<!doctype html><title>Agent Studio</title><script type="module" src="./app.a1b2c3d4.js"></script>',
  );
  await writeFile(join(assetsRoot, "styles.css"), "body { color: white; }");
  await writeFile(join(assetsRoot, "app.js"), "export const ready = true;");
  await writeFile(join(assetsRoot, "application.js"), "export const ready = true;");
  await writeFile(join(assetsRoot, "app.production.js"), "export const ready = true;");
  await writeFile(join(assetsRoot, "vendor.release.2026.js"), "export const ready = true;");
  await writeFile(
    join(assetsRoot, "app.a1b2c3d4.js"),
    'document.documentElement.dataset.moduleLoaded = "true";',
  );
  await writeFile(join(assetsRoot, "chunk-deadbeef0123.css"), "body { color: white; }");
});

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  openServers.clear();
  await rm(assetsRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function recordingBroker() {
  const calls: Array<{ request: unknown; sourceIp: string }> = [];
  const broker: PanelRequestBroker = {
    async handle(request, sourceIp) {
      calls.push({ request, sourceIp });
      if (request.action === "connect") return { ok: true, connectionId };
      return { ok: true };
    },
  };
  return { broker, calls };
}

async function startHandler(broker: PanelRequestBroker, hostPanel = false) {
  const panelHandler = createAgentStudioHttpHandler({ assetsRoot, broker });
  const server = createServer((request, response) => {
    if (hostPanel && request.url === "/host") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><iframe sandbox="allow-scripts" src="/plugins/agent-studio/"></iframe>',
      );
      return;
    }
    void panelHandler(request, response);
  });
  openServers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  return { server, port: address.port };
}

async function send(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string | number>;
    chunks?: Buffer[];
  } = {},
): Promise<ResponseSnapshot> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on("error", reject);
    for (const chunk of options.chunks ?? []) request.write(chunk);
    request.end();
  });
}

function postHeaders(body: Buffer | string, overrides: Record<string, string | number> = {}) {
  return {
    Origin: "null",
    "Content-Type": "text/plain",
    "Content-Length": Buffer.byteLength(body),
    ...overrides,
  };
}

describe("Agent Studio HTTP handler", () => {
  it("serves panel files with MIME, sandbox CSP, and immutable caching only for hashed assets", async () => {
    const { broker } = recordingBroker();
    const { port } = await startHandler(broker);

    const index = await send(port, "/plugins/agent-studio/");
    const css = await send(port, "/plugins/agent-studio/styles.css?theme=dark");
    const unhashed = await send(port, "/plugins/agent-studio/app.js");
    const longUnhashed = await send(port, "/plugins/agent-studio/application.js");
    const semantic = await send(port, "/plugins/agent-studio/app.production.js");
    const multiDotSemantic = await send(port, "/plugins/agent-studio/vendor.release.2026.js");
    const hashed = await send(port, "/plugins/agent-studio/app.a1b2c3d4.js");
    const hashedCss = await send(port, "/plugins/agent-studio/chunk-deadbeef0123.css");

    expect(index.status).toBe(200);
    expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(index.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(index.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(index.headers["x-content-type-options"]).toBe("nosniff");
    expect(index.headers["access-control-allow-origin"]).toBe("null");
    expect(index.headers.vary).toBe("Origin");
    expect(index.headers["cache-control"]).toBe("no-store");
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(unhashed.headers["cache-control"]).toBe("no-store");
    expect(longUnhashed.headers["cache-control"]).toBe("no-store");
    expect(semantic.headers["cache-control"]).toBe("no-store");
    expect(multiDotSemantic.headers["cache-control"]).toBe("no-store");
    expect(hashed.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(hashed.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(hashedCss.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("loads an external module in a scripts-only opaque iframe", async () => {
    if (!browserExecutable) throw new Error("Chrome or Edge executable is required for HTTP tests");
    const { broker } = recordingBroker();
    const { port } = await startHandler(broker, true);
    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/host`, { waitUntil: "domcontentloaded" });
      let panelFrame: BrowserFrame | undefined;
      await expect
        .poll(async () => {
          panelFrame = page
            .frames()
            .find((frame) => frame.url().endsWith("/plugins/agent-studio/"));
          return await panelFrame?.evaluate<string | undefined>(
            "document.documentElement.dataset.moduleLoaded",
          );
        })
        .toBe("true");
      if (!panelFrame) throw new Error("panel frame did not load");

      expect(await panelFrame.evaluate<string>("self.origin")).toBe("null");
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it.each([
    "/plugins/agent-studio/../secret.txt",
    "/plugins/agent-studio/%2e%2e/secret.txt",
    "/plugins/agent-studio/%2E%2E%2Fsecret.txt",
    "/plugins/agent-studio/%5c..%5csecret.txt",
  ])("rejects traversal without reading outside the asset root: %s", async (path) => {
    const { broker } = recordingBroker();
    const { port } = await startHandler(broker);

    const response = await send(port, path);

    expect(response.status).toBe(400);
    expect(response.body.toString("utf8")).not.toContain("secret");
  });

  it("routes the closed request union to the broker and never logs request bodies", async () => {
    const consoleSpies = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const { broker, calls } = recordingBroker();
    const { port } = await startHandler(broker);
    const bodies = [
      JSON.stringify({ action: "connect", token: "never-log-this-token" }),
      JSON.stringify({ action: "disconnect", connectionId }),
      JSON.stringify({
        action: "operation",
        connectionId,
        operation: "agents.list",
        payload: {},
      }),
    ];

    for (const body of bodies) {
      const response = await send(port, "/plugins/agent-studio/api", {
        method: "POST",
        headers: postHeaders(body),
        chunks: [Buffer.from(body)],
      });
      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe("null");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    }

    expect(calls.map(({ request }) => request)).toEqual([
      { action: "connect", token: "never-log-this-token" },
      { action: "disconnect", connectionId },
      { action: "operation", connectionId, operation: "agents.list", payload: {} },
    ]);
    expect(calls.every(({ sourceIp }) => sourceIp === "127.0.0.1")).toBe(true);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls).join(" ")).not.toContain(
      "never-log-this-token",
    );
  });

  const rejectedRequests: Array<{
    name: string;
    headers: Record<string, string | number>;
    status: number;
  }> = [
    { name: "normal origin", headers: { Origin: "https://evil.example" }, status: 403 },
    { name: "missing origin", headers: { Origin: "" }, status: 403 },
    {
      name: "JSON content type",
      headers: { "Content-Type": "application/json" },
      status: 415,
    },
    {
      name: "form content type",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      status: 415,
    },
  ];

  it.each(rejectedRequests)("rejects $name before broker dispatch", async ({ headers, status }) => {
    const body = JSON.stringify({ action: "connect", token: "secret" });
    const { broker, calls } = recordingBroker();
    const { port } = await startHandler(broker);

    const response = await send(port, "/plugins/agent-studio/api", {
      method: "POST",
      headers: postHeaders(body, headers),
      chunks: [Buffer.from(body)],
    });

    expect(response.status).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(calls).toHaveLength(0);
  });

  it("enforces the exact API path and a 64 KiB UTF-8 body limit", async () => {
    const { broker, calls } = recordingBroker();
    const { port } = await startHandler(broker);
    const body = Buffer.alloc(64 * 1024 + 1, 0x61);

    const wrongPath = await send(port, "/plugins/agent-studio/api/extra", {
      method: "POST",
      headers: postHeaders("{}"),
      chunks: [Buffer.from("{}")],
    });
    const oversized = await send(port, "/plugins/agent-studio/api", {
      method: "POST",
      headers: postHeaders(body),
      chunks: [body],
    });
    const invalidUtf8 = await send(port, "/plugins/agent-studio/api", {
      method: "POST",
      headers: postHeaders(Buffer.from([0xc3, 0x28])),
      chunks: [Buffer.from([0xc3, 0x28])],
    });

    expect(wrongPath.status).toBe(404);
    expect(oversized.status).toBe(413);
    expect(invalidUtf8.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rejects an oversized streaming sender before EOF and terminates it cleanly", async () => {
    const { broker, calls } = recordingBroker();
    const handler = createAgentStudioHttpHandler({ assetsRoot, broker });
    const request = new PassThrough() as PassThrough & IncomingMessage;
    Object.assign(request, {
      method: "POST",
      url: "/plugins/agent-studio/api",
      headers: { origin: "null", "content-type": "text/plain" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 0,
      headers: new Map<string, string | number>(),
      ended: false,
      setHeader(name: string, value: string | number) {
        response.headers.set(name.toLowerCase(), value);
      },
      end() {
        response.ended = true;
        response.emit("finish");
      },
    }) as EventEmitter & ServerResponse & {
      headers: Map<string, string | number>;
      ended: boolean;
    };
    const handled = handler(request, response);

    request.write(Buffer.alloc(64 * 1024 + 1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    try {
      expect(response.statusCode).toBe(413);
      expect(response.ended).toBe(true);
      expect(response.headers.get("connection")).toBe("close");
      expect(request.destroyed).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      if (!request.destroyed) request.end();
      await handled;
    }
  });

  it.each(["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"])(
    "rejects unsupported %s requests",
    async (method) => {
      const { broker, calls } = recordingBroker();
      const { port } = await startHandler(broker);

      const response = await send(port, "/plugins/agent-studio/api", { method });

      expect(response.status).toBe(405);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(calls).toHaveLength(0);
    },
  );
});
