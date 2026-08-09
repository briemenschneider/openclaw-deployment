import { accessSync, constants } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentStudioHttpHandler } from "../../src/http-handler.js";

const connectionId = "c".repeat(64);
const features = {
  listAgents: true,
  updateAgent: true,
  listAgentFiles: true,
  getAgentFile: true,
  setAgentFile: true,
  listModels: true,
  listSessions: true,
  createSession: true,
};
const openServers = new Set<Server>();

type BrowserFrame = {
  evaluate<T>(expression: string): Promise<T>;
  url(): string;
};

type BrowserPage = {
  close(): Promise<void>;
  evaluate<T>(expression: string): Promise<T>;
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

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    ),
  );
  openServers.clear();
});

async function startBuiltPanel(): Promise<{ port: number; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  const handler = createAgentStudioHttpHandler({
    assetsRoot: resolve(process.cwd(), "dist/ui"),
    broker: {
      async handle(request) {
        if (request.action === "connect") {
          requests.push({ action: "connect", tokenMatched: request.token === "browser-only-token" });
          return { ok: true, connectionId, features };
        }
        requests.push({ action: request.action });
        return { ok: true };
      },
    },
  });
  const server = createServer((request, response) => {
    if (request.url === "/host") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><iframe title="Panel" style="width:420px;height:700px" sandbox="allow-scripts" src="/plugins/agent-studio/"></iframe>',
      );
      return;
    }
    void handler(request, response);
  });
  openServers.add(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  return { port: address.port, requests };
}

describe("built panel in a real scripts-only browser frame", () => {
  it("stays isolated, clears the token, and disconnects when its parent removes the iframe", async () => {
    if (!browserExecutable) throw new Error("Chrome or Edge executable is required for UI tests");
    const { port, requests } = await startBuiltPanel();
    const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${port}/host`, { waitUntil: "domcontentloaded" });
      let panel: BrowserFrame | undefined;
      await expect
        .poll(async () => {
          panel = page.frames().find((frame) => frame.url().endsWith("/plugins/agent-studio/"));
          return await panel?.evaluate<boolean>("Boolean(document.querySelector('#gateway-token'))");
        })
        .toBe(true);
      if (!panel) throw new Error("panel frame did not load");

      expect(await panel.evaluate<string>("self.origin")).toBe("null");
      expect(
        await panel.evaluate<string>(
          "(() => { try { void localStorage.length; return 'available'; } catch (error) { return error.name; } })()",
        ),
      ).toBe("SecurityError");
      expect(
        await panel.evaluate<string>(
          "(() => { try { void parent.document.body; return 'available'; } catch (error) { return error.name; } })()",
        ),
      ).toBe("SecurityError");

      await panel.evaluate<void>(
        "(() => { const input = document.querySelector('#gateway-token'); input.value = 'browser-only-token'; document.querySelector('.primary-action').click(); })()",
      );
      await expect.poll(() => requests.length).toBe(1);
      await expect.poll(async () => await panel?.evaluate<boolean>("Boolean(document.querySelector('#disconnect'))")).toBe(true);

      expect(await panel.evaluate<string>("document.body.innerHTML")).not.toContain("browser-only-token");
      expect(requests).toEqual([{ action: "connect", tokenMatched: true }]);
      expect(
        await panel.evaluate<string>(
          "getComputedStyle(document.querySelector('#directory-toggle')).display",
        ),
      ).toBe("grid");
      await panel.evaluate<void>("document.querySelector('#directory-toggle').click()");
      expect(await panel.evaluate<boolean>("document.querySelector('#agent-directory').hasAttribute('data-open')")).toBe(true);

      await page.evaluate<void>("document.querySelector('iframe').remove()");
      await expect.poll(() => requests.length).toBe(2);
      expect(requests.at(-1)).toEqual({ action: "disconnect" });
    } finally {
      await page.close();
      await browser.close();
    }
  });
});
