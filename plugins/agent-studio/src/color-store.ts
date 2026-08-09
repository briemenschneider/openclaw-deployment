import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

const STATE_VERSION = 1;
const PLUGIN_STATE_DIRECTORY = "agent-studio";
const COLORS_FILE = "colors.json";
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

type ColorState = {
  version: typeof STATE_VERSION;
  agents: Record<string, string>;
};

type ColorStoreFileSystem = Pick<typeof fs, "mkdir" | "open" | "readFile" | "rename" | "unlink">;

export type AgentColorStoreOptions = {
  fileSystem?: ColorStoreFileSystem;
};

export type SetAgentColorResult =
  | { ok: true; color: string }
  | { ok: false };

function emptyState(): ColorState {
  return { version: STATE_VERSION, agents: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_PATTERN.test(value);
}

export function normalizeAgentColor(value: unknown): string | undefined {
  return typeof value === "string" && COLOR_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

function parseState(value: unknown): ColorState | undefined {
  if (!isRecord(value) || value.version !== STATE_VERSION || !isRecord(value.agents)) return undefined;
  const agents: Record<string, string> = {};
  for (const [agentId, color] of Object.entries(value.agents)) {
    const normalized = normalizeAgentColor(color);
    if (!isAgentId(agentId) || !normalized) return undefined;
    agents[agentId] = normalized;
  }
  return { version: STATE_VERSION, agents };
}

function cloneAgents(agents: Record<string, string>): Record<string, string> {
  return { ...agents };
}

/**
 * Plugin-owned presentation state. The state root comes only from the host runtime;
 * browser requests can select an agent id and color but never a filesystem location.
 */
export class AgentColorStore {
  readonly #directory: string;
  readonly #stateFile: string;
  readonly #fileSystem: ColorStoreFileSystem;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(stateDir: string, options: AgentColorStoreOptions = {}) {
    this.#directory = join(stateDir, PLUGIN_STATE_DIRECTORY);
    this.#stateFile = join(this.#directory, COLORS_FILE);
    this.#fileSystem = options.fileSystem ?? fs;
  }

  async list(): Promise<Record<string, string>> {
    return await this.#serialize(async () => cloneAgents(await this.#readState().then((state) => state.agents)));
  }

  async set(agentId: unknown, color: unknown): Promise<SetAgentColorResult> {
    const normalized = normalizeAgentColor(color);
    if (!isAgentId(agentId) || !normalized) return { ok: false };

    return await this.#serialize(async () => {
      const state = await this.#readState();
      state.agents[agentId] = normalized;
      try {
        await this.#writeState(state);
        return { ok: true, color: normalized };
      } catch {
        return { ok: false };
      }
    });
  }

  async #readState(): Promise<ColorState> {
    try {
      const raw = await this.#fileSystem.readFile(this.#stateFile, "utf8");
      return parseState(JSON.parse(raw)) ?? emptyState();
    } catch {
      // Corruption and unreadable state intentionally recover to a safe empty view.
      return emptyState();
    }
  }

  async #writeState(state: ColorState): Promise<void> {
    await this.#fileSystem.mkdir(this.#directory, { recursive: true });
    const temporaryFile = join(
      this.#directory,
      `.${COLORS_FILE}.${randomBytes(16).toString("hex")}.tmp`,
    );
    let fileHandle: Awaited<ReturnType<ColorStoreFileSystem["open"]>> | undefined;
    let renamed = false;

    try {
      fileHandle = await this.#fileSystem.open(temporaryFile, "wx", 0o600);
      await fileHandle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;
      await this.#fileSystem.rename(temporaryFile, this.#stateFile);
      renamed = true;
      await this.#syncDirectory();
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => undefined);
      if (!renamed) await this.#fileSystem.unlink(temporaryFile).catch(() => undefined);
    }
  }

  async #syncDirectory(): Promise<void> {
    let directoryHandle: Awaited<ReturnType<ColorStoreFileSystem["open"]>> | undefined;
    try {
      directoryHandle = await this.#fileSystem.open(this.#directory, "r");
      await directoryHandle.sync();
    } catch {
      // Some platforms cannot fsync directories; the file itself has already been synced.
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
  }

  async #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}
