import type { AgentStudioApi, AgentStudioFeatures } from "./api-client.js";

/**
 * Constrained palette offered by the picker. Custom entries are still allowed, but
 * they must normalize to the same six-digit form the broker accepts.
 */
export const AGENT_COLOR_PALETTE = [
  "#e2664f",
  "#e39b3c",
  "#d8c14a",
  "#7fbf5a",
  "#4fb59a",
  "#4f9ed8",
  "#7b7fe0",
  "#b76fd0",
  "#d6608f",
  "#8c8f9a",
] as const;

export const AGENT_COLOR_NAMES: Readonly<Record<string, string>> = {
  "#e2664f": "Coral",
  "#e39b3c": "Amber",
  "#d8c14a": "Brass",
  "#7fbf5a": "Moss",
  "#4fb59a": "Teal",
  "#4f9ed8": "Azure",
  "#7b7fe0": "Indigo",
  "#b76fd0": "Orchid",
  "#d6608f": "Rose",
  "#8c8f9a": "Slate",
};

const SHORT_HEX = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const LONG_HEX = /^#?[0-9a-f]{6}$/i;

export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  const short = SHORT_HEX.exec(candidate);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  if (LONG_HEX.test(candidate)) {
    return `#${candidate.replace("#", "")}`.toLowerCase();
  }
  return undefined;
}

export type DirectoryAgent = {
  id: string;
  label: string;
  emoji?: string;
  model?: string;
  color?: string;
};

export type AgentDirectoryStatus = "idle" | "loading" | "ready" | "error";

export type AgentDirectoryState = {
  status: AgentDirectoryStatus;
  /** Sorted and filtered view of the directory. */
  agents: DirectoryAgent[];
  /** Agents known before the search filter, so callers can distinguish empty from no-match. */
  totalCount: number;
  query: string;
  selectedId?: string;
  errorText?: string;
  colorErrorText?: string;
};

export type AgentDirectoryStore = {
  getState(): AgentDirectoryState;
  subscribe(listener: (state: AgentDirectoryState) => void): () => void;
  load(): Promise<void>;
  select(agentId: string): void;
  setQuery(query: string): void;
  setColor(agentId: string, color: string): Promise<void>;
};

export type AgentDirectoryStoreOptions = {
  api: Pick<AgentStudioApi, "operation">;
  connectionId: string;
  features: AgentStudioFeatures;
};

const LIST_UNAVAILABLE = "This Gateway does not expose agent listing.";
const LIST_FAILED = "Agent directory unavailable.";
const COLOR_INVALID = "Enter a color as #rrggbb.";
const COLOR_FAILED = "Could not save that color. Reverting.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseAgent(value: unknown): DirectoryAgent | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;
  const identity = isRecord(value.identity) ? value.identity : undefined;
  const model = isRecord(value.model) ? value.model : undefined;
  return {
    id: value.id,
    label: optionalString(identity?.name) ?? optionalString(value.name) ?? value.id,
    emoji: optionalString(identity?.emoji),
    model: optionalString(model?.primary),
  };
}

export function parseAgentsResponse(value: unknown): {
  defaultId?: string;
  agents: DirectoryAgent[];
} {
  if (!isRecord(value)) return { agents: [] };
  const agents = Array.isArray(value.agents)
    ? value.agents.map(parseAgent).filter((agent): agent is DirectoryAgent => agent !== undefined)
    : [];
  return { defaultId: optionalString(value.defaultId), agents };
}

export function parseColorsResponse(value: unknown): Record<string, string> {
  if (!isRecord(value) || !isRecord(value.colors)) return {};
  const colors: Record<string, string> = {};
  for (const [agentId, color] of Object.entries(value.colors)) {
    const normalized = normalizeHexColor(color);
    if (normalized) colors[agentId] = normalized;
  }
  return colors;
}

/** Deterministic ordering: the default agent leads, then case-insensitive label, then id. */
export function sortAgents(agents: readonly DirectoryAgent[], defaultId?: string): DirectoryAgent[] {
  return [...agents].sort((left, right) => {
    if (left.id === defaultId) return right.id === defaultId ? 0 : -1;
    if (right.id === defaultId) return 1;
    const leftLabel = left.label.toLowerCase();
    const rightLabel = right.label.toLowerCase();
    if (leftLabel !== rightLabel) return leftLabel < rightLabel ? -1 : 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

export function filterAgents(agents: readonly DirectoryAgent[], query: string): DirectoryAgent[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...agents];
  return agents.filter(
    (agent) =>
      agent.label.toLowerCase().includes(needle) || agent.id.toLowerCase().includes(needle),
  );
}

export function createAgentDirectoryStore(options: AgentDirectoryStoreOptions): AgentDirectoryStore {
  const { api, connectionId, features } = options;
  const listeners = new Set<(state: AgentDirectoryState) => void>();

  let status: AgentDirectoryStatus = "idle";
  let all: DirectoryAgent[] = [];
  let query = "";
  let selectedId: string | undefined;
  let errorText: string | undefined;
  let colorErrorText: string | undefined;

  function snapshot(): AgentDirectoryState {
    return {
      status,
      agents: filterAgents(all, query),
      totalCount: all.length,
      query,
      selectedId,
      errorText,
      colorErrorText,
    };
  }

  function notify(): void {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  }

  function applyColors(colors: Record<string, string>): void {
    all = all.map((agent) => ({ ...agent, color: colors[agent.id] }));
  }

  async function loadColors(): Promise<Record<string, string>> {
    try {
      return parseColorsResponse(await api.operation(connectionId, "colors.list", {}));
    } catch {
      // Presentation state is optional; the directory stays usable without it.
      return {};
    }
  }

  return {
    getState: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async load() {
      if (!features.listAgents) {
        status = "error";
        errorText = LIST_UNAVAILABLE;
        notify();
        return;
      }

      status = "loading";
      errorText = undefined;
      notify();

      let listed: { defaultId?: string; agents: DirectoryAgent[] };
      try {
        listed = parseAgentsResponse(await api.operation(connectionId, "listAgents", {}));
      } catch {
        status = "error";
        all = [];
        selectedId = undefined;
        errorText = LIST_FAILED;
        notify();
        return;
      }

      const colors = await loadColors();
      all = sortAgents(listed.agents, listed.defaultId);
      applyColors(colors);
      selectedId = all.some((agent) => agent.id === listed.defaultId)
        ? listed.defaultId
        : all[0]?.id;
      status = "ready";
      errorText = undefined;
      notify();
    },

    select(agentId) {
      if (!all.some((agent) => agent.id === agentId) || agentId === selectedId) return;
      selectedId = agentId;
      notify();
    },

    setQuery(next) {
      if (next === query) return;
      query = next;
      notify();
    },

    async setColor(agentId, color) {
      const normalized = normalizeHexColor(color);
      const index = all.findIndex((agent) => agent.id === agentId);
      if (index < 0) return;
      if (!normalized) {
        colorErrorText = COLOR_INVALID;
        notify();
        return;
      }

      const previous = all[index].color;
      all = all.map((agent) => (agent.id === agentId ? { ...agent, color: normalized } : agent));
      colorErrorText = undefined;
      notify();

      try {
        await api.operation(connectionId, "colors.set", { agentId, color: normalized });
      } catch {
        all = all.map((agent) => (agent.id === agentId ? { ...agent, color: previous } : agent));
        colorErrorText = COLOR_FAILED;
        notify();
      }
    },
  };
}
