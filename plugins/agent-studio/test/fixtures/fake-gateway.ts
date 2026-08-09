import { accessSync, constants } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";

export type CapturedHttpRequest = {
  method: string;
  pathname: string;
  origin: string | null;
  contentType: string | null;
};

export type FakeGateway = {
  browserPost(pathname: string, init: { body: string; headers: Record<string, string> }): Promise<void>;
  gatewayUrl: string;
  connectAttempts: Array<{ token: string | undefined; scopes: string[] | undefined }>;
  httpRequests: CapturedHttpRequest[];
  activeConnectionCount(): number;
  stop(): Promise<void>;
};

type BrowserPage = {
  close(): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForFunction(expression: string): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
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

type SocketData = { toString(): string };
type ServerSocket = {
  send(data: string): void;
  terminate(): void;
  on(event: "message", listener: (data: SocketData) => void): void;
  on(event: "close", listener: () => void): void;
};
type WebSocketServerInstance = {
  on(event: "connection", listener: (socket: ServerSocket) => void): void;
  close(callback: (error?: Error) => void): void;
};
type WsModule = {
  WebSocketServer: new (options: { server: Server }) => WebSocketServerInstance;
};

const require = createRequire(import.meta.url);
const requireFromOpenClaw = createRequire(require.resolve("openclaw/plugin-sdk/gateway-runtime"));
const { chromium } = requireFromOpenClaw("playwright-core") as PlaywrightCore;
const { WebSocketServer } = requireFromOpenClaw("ws") as WsModule;

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

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

async function readBody(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // Drain the request so Chrome can reuse and close the connection cleanly.
  }
}

export async function startFakeGateway(): Promise<FakeGateway> {
  const httpRequests: CapturedHttpRequest[] = [];
  const connectAttempts: Array<{ token: string | undefined; scopes: string[] | undefined }> = [];
  const activeSockets = new Set<ServerSocket>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/host") {
      const frameSearch = url.searchParams.toString();
      writeHtml(
        response,
        `<!doctype html><script>
          window.__transportDone = false;
          window.__transportError = null;
          addEventListener("message", (event) => {
            if (event.data?.type !== "transport-result") return;
            window.__transportDone = true;
            window.__transportError = event.data.error ?? null;
          });
        </script><iframe sandbox="allow-scripts" src="/opaque-frame?${frameSearch}"></iframe>`,
      );
      return;
    }

    if (url.pathname === "/opaque-frame") {
      const pathname = url.searchParams.get("pathname") ?? "/bridge";
      const body = url.searchParams.get("body") ?? "";
      const headers = JSON.parse(url.searchParams.get("headers") ?? "{}") as Record<string, string>;
      writeHtml(
        response,
        `<!doctype html><script>
          fetch(${JSON.stringify(pathname)}, {
            method: "POST",
            headers: ${JSON.stringify(headers)},
            body: ${JSON.stringify(body)}
          }).then((response) => {
            if (!response.ok) throw new Error("HTTP " + response.status);
            parent.postMessage({ type: "transport-result" }, "*");
          }).catch((error) => {
            parent.postMessage({ type: "transport-result", error: String(error) }, "*");
          });
        </script>`,
      );
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    await readBody(request);
    httpRequests.push({
      method: request.method ?? "",
      pathname: url.pathname,
      origin: request.headers.origin ?? null,
      contentType: request.headers["content-type"] ?? null,
    });
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "null",
      "Content-Type": "text/plain",
    };
    if (request.method === "OPTIONS") {
      corsHeaders["Access-Control-Allow-Methods"] = "POST";
      corsHeaders["Access-Control-Allow-Headers"] = "authorization, content-type";
    }
    response.writeHead(200, corsHeaders);
    response.end("ok");
  });
  const webSocketServer = new WebSocketServer({ server });
  let connectionSequence = 0;
  webSocketServer.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "agent-studio-test-nonce" },
      }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as {
        type: string;
        id: string;
        method: string;
        params?: {
          auth?: { token?: string };
          scopes?: string[];
          value?: string;
        };
      };
      if (frame.type !== "req") return;
      if (frame.method === "connect") {
        const token = frame.params?.auth?.token;
        const scopes = frame.params?.scopes;
        connectAttempts.push({ token, scopes });
        if (token !== "agent-studio-test-token") {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "invalid token",
                details: { code: "AUTH_TOKEN_MISMATCH" },
              },
            }),
          );
          return;
        }
        connectionSequence += 1;
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: {
              type: "hello-ok",
              protocol: 4,
              server: { version: "2026.7.1-test", connId: `fake-${connectionSequence}` },
              features: { methods: ["agent-studio.echo"], events: [] },
              snapshot: {
                presence: [],
                health: { ok: true },
                stateVersion: { presence: 0, health: 0 },
                uptimeMs: 0,
                authMode: "token",
              },
              auth: { role: "operator", scopes: scopes ?? [] },
              policy: { maxPayload: 1_048_576, maxBufferedBytes: 1_048_576, tickIntervalMs: 30_000 },
            },
          }),
        );
        return;
      }
      if (frame.method === "agent-studio.echo") {
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok: true,
            payload: { value: frame.params?.value },
          }),
        );
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake gateway did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    gatewayUrl: `ws://127.0.0.1:${address.port}`,
    connectAttempts,
    httpRequests,
    activeConnectionCount: () => activeSockets.size,
    async browserPost(pathname, init) {
      if (!browserExecutable) throw new Error("Chrome or Edge executable is required for transport spike");
      const search = new URLSearchParams({
        pathname,
        body: init.body,
        headers: JSON.stringify(init.headers),
      });
      const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
      const page = await browser.newPage();
      try {
        await page.goto(`${origin}/host?${search}`);
        await page.waitForFunction("window.__transportDone === true");
        const error = await page.evaluate<string | null>("window.__transportError");
        if (error) throw new Error(error);
      } finally {
        await page.close();
        await browser.close();
      }
    },
    async stop() {
      for (const socket of activeSockets) socket.terminate();
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => (error ? reject(error) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
