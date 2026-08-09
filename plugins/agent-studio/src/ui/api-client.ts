export const FEATURE_NAMES = [
  "listAgents",
  "updateAgent",
  "listAgentFiles",
  "getAgentFile",
  "setAgentFile",
  "listModels",
  "listSessions",
  "createSession",
] as const;

export type AgentStudioFeatures = Record<(typeof FEATURE_NAMES)[number], boolean>;

export type ConnectResult = {
  connectionId: string;
  features: AgentStudioFeatures;
};

export type AgentStudioApi = {
  connect(token: string): Promise<ConnectResult>;
  disconnect(connectionId: string): Promise<void>;
};

export type AgentStudioApiErrorCode = "CONNECT_FAILED" | "DISCONNECT_FAILED";

export class AgentStudioApiError extends Error {
  constructor(readonly code: AgentStudioApiErrorCode) {
    super(code === "CONNECT_FAILED" ? "Connection failed" : "Disconnect failed");
    this.name = "AgentStudioApiError";
  }
}

const CONNECTION_ID_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConnectResult(value: unknown): ConnectResult | undefined {
  if (!isRecord(value) || value.ok !== true || !CONNECTION_ID_PATTERN.test(String(value.connectionId))) {
    return undefined;
  }
  if (!isRecord(value.features)) return undefined;
  const features = {} as AgentStudioFeatures;
  for (const name of FEATURE_NAMES) {
    if (typeof value.features[name] !== "boolean") return undefined;
    features[name] = value.features[name];
  }
  return { connectionId: String(value.connectionId), features };
}

async function post(fetcher: typeof fetch, body: string): Promise<unknown> {
  const response = await fetcher("./api", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
    credentials: "omit",
  });
  if (!response.ok) throw new Error("request failed");
  return await response.json() as unknown;
}

export function createAgentStudioApiClient(fetcher: typeof fetch = globalThis.fetch): AgentStudioApi {
  return {
    async connect(token) {
      try {
        const value = await post(fetcher, JSON.stringify({ action: "connect", token }));
        const result = parseConnectResult(value);
        if (!result) throw new Error("invalid response");
        return result;
      } catch {
        throw new AgentStudioApiError("CONNECT_FAILED");
      }
    },

    async disconnect(connectionId) {
      try {
        const value = await post(
          fetcher,
          JSON.stringify({ action: "disconnect", connectionId }),
        );
        if (!isRecord(value) || value.ok !== true) throw new Error("invalid response");
      } catch {
        throw new AgentStudioApiError("DISCONNECT_FAILED");
      }
    },
  };
}
