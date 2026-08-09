import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentColorStore } from "../src/color-store.js";
import { createPanelRequestBroker } from "../src/gateway-operations.js";
import { createAgentStudioColorStore, shutdownAgentStudioResources } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryStateDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-studio-colors-"));
  temporaryDirectories.push(directory);
  return directory;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("AgentColorStore", () => {
  it("uses the public runtime state resolver for its plugin-owned location", async () => {
    const stateDir = await temporaryStateDir();
    let receivedEnvironment: NodeJS.ProcessEnv | undefined;
    const store = createAgentStudioColorStore({
      runtime: {
        state: {
          resolveStateDir(environment) {
            receivedEnvironment = environment;
            return stateDir;
          },
        },
      },
    });

    await store.set("main", "#123456");
    expect(receivedEnvironment).toBe(process.env);
    await expect(readFile(join(stateDir, "agent-studio", "colors.json"), "utf8")).resolves.toContain(
      '"main":"#123456"',
    );
  });

  it("persists normalized colors in its plugin-namespaced state directory", async () => {
    const stateDir = await temporaryStateDir();
    const store = new AgentColorStore(stateDir);

    await expect(store.list()).resolves.toEqual({});
    await expect(store.set("main", "#Ef5B5B")).resolves.toEqual({ ok: true, color: "#ef5b5b" });
    await expect(store.list()).resolves.toEqual({ main: "#ef5b5b" });
    await expect(readFile(join(stateDir, "agent-studio", "colors.json"), "utf8")).resolves.toBe(
      '{"version":1,"agents":{"main":"#ef5b5b"}}\n',
    );
  });

  it.each(["#fff", "ef5b5b", "#ef5b5bg", "#ef5b5", "#EF5B5Z", "", "#12345\n"])(
    "rejects invalid six-digit color %j without writing",
    async (color) => {
      const stateDir = await temporaryStateDir();
      const store = new AgentColorStore(stateDir);

      await expect(store.set("main", color)).resolves.toEqual({ ok: false });
      await expect(store.list()).resolves.toEqual({});
    },
  );

  it("serializes concurrent mutations without losing any agent color", async () => {
    const stateDir = await temporaryStateDir();
    const store = new AgentColorStore(stateDir);

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) =>
        await store.set(`agent-${index}`, `#${index.toString(16).padStart(6, "0")}`),
      ),
    );

    await expect(store.list()).resolves.toEqual(
      Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `agent-${index}`,
          `#${index.toString(16).padStart(6, "0")}`,
        ]),
      ),
    );
  });

  it("recovers safely from corrupt JSON and preserves stored colors for unknown agent ids", async () => {
    const stateDir = await temporaryStateDir();
    const statePath = join(stateDir, "agent-studio", "colors.json");
    const store = new AgentColorStore(stateDir);

    await writeFile(join(stateDir, "placeholder"), "", "utf8");
    await expect(store.list()).resolves.toEqual({});
    await store.set("retired-agent", "#123456");
    await store.set("main", "#abcdef");
    await expect(store.list()).resolves.toEqual({ "retired-agent": "#123456", main: "#abcdef" });

    await writeFile(statePath, "{not JSON", "utf8");
    await expect(store.list()).resolves.toEqual({});
    await store.set("main", "#010203");
    await expect(store.list()).resolves.toEqual({ main: "#010203" });
    await expect(readdir(join(stateDir, "agent-studio"))).resolves.toEqual(["colors.json"]);
  });

  it("handles closed local color operations without calling Gateway and survives a broker restart", async () => {
    const stateDir = await temporaryStateDir();
    let gatewayCalls = 0;
    const sessions = {
      async connect() {
        return { ok: false };
      },
      async disconnect() {
        return { ok: true };
      },
      getOperationSession(connectionId: string) {
        if (connectionId !== "a".repeat(64)) return undefined;
        return {
          client: {
            async request<T>(): Promise<T> {
              gatewayCalls += 1;
              return {} as T;
            },
          },
          advertisedMethods: new Set(["agents.list"]),
        };
      },
    };
    const connectionId = "a".repeat(64);
    const broker = createPanelRequestBroker(sessions, new AgentColorStore(stateDir));

    await expect(
      broker.handle(
        { action: "operation", connectionId, operation: "colors.list", payload: {} },
        "192.0.2.1",
      ),
    ).resolves.toEqual({ ok: true, data: { colors: {} } });
    await expect(
      broker.handle(
        {
          action: "operation",
          connectionId,
          operation: "colors.set",
          payload: { agentId: "main", color: "#ABCDEF" },
        },
        "192.0.2.1",
      ),
    ).resolves.toEqual({ ok: true, data: { agentId: "main", color: "#abcdef" } });
    await expect(
      broker.handle(
        {
          action: "operation",
          connectionId,
          operation: "colors.set",
          payload: { agentId: "main", color: "#abcdef", path: "C:\\secret" },
        },
        "192.0.2.1",
      ),
    ).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_PAYLOAD", message: "Invalid operation payload" },
    });
    expect(gatewayCalls).toBe(0);

    const restartedBroker = createPanelRequestBroker(sessions, new AgentColorStore(stateDir));
    await expect(
      restartedBroker.handle(
        { action: "operation", connectionId, operation: "colors.list", payload: {} },
        "192.0.2.1",
      ),
    ).resolves.toEqual({ ok: true, data: { colors: { main: "#abcdef" } } });
    expect(gatewayCalls).toBe(0);
  });

  it("drains an in-flight atomic write before shutdown and rejects later lifecycle use", async () => {
    const stateDir = await temporaryStateDir();
    const renameEntered = deferred();
    const allowRename = deferred();
    let renameCalls = 0;
    const store = new AgentColorStore(stateDir, {
      fileSystem: {
        mkdir,
        open,
        readFile,
        unlink,
        async rename(from, to) {
          renameCalls += 1;
          renameEntered.resolve();
          await allowRename.promise;
          await rename(from, to);
        },
      },
    });

    const writing = store.set("main", "#123456");
    await renameEntered.promise;
    let shutdownFinished = false;
    const stopping = store.shutdown().then(() => {
      shutdownFinished = true;
    });

    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    await expect(store.set("later", "#abcdef")).rejects.toThrow("Color state unavailable");
    await expect(store.list()).rejects.toThrow("Color state unavailable");

    allowRename.resolve();
    await expect(writing).resolves.toEqual({ ok: true, color: "#123456" });
    await stopping;
    expect(renameCalls).toBe(1);
    await expect(readdir(join(stateDir, "agent-studio"))).resolves.toEqual(["colors.json"]);
    await expect(store.shutdown()).resolves.toBeUndefined();
  });

  it("drains failed writes without unhandled rejection or a temporary file leak", async () => {
    const stateDir = await temporaryStateDir();
    const store = new AgentColorStore(stateDir, {
      fileSystem: {
        mkdir,
        open,
        readFile,
        unlink,
        async rename() {
          throw new Error("controlled rename failure");
        },
      },
    });

    const writing = store.set("main", "#123456");
    const stopping = store.shutdown();

    await expect(writing).resolves.toEqual({ ok: false });
    await expect(stopping).resolves.toBeUndefined();
    await expect(readdir(join(stateDir, "agent-studio"))).resolves.toEqual([]);
  });

  it("waits for color shutdown even when session shutdown fails", async () => {
    const calls: string[] = [];

    await expect(
      shutdownAgentStudioResources(
        {
          async shutdown() {
            calls.push("sessions");
            throw new Error("session failure");
          },
        },
        {
          async shutdown() {
            calls.push("colors");
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(calls.sort()).toEqual(["colors", "sessions"]);
  });
});
