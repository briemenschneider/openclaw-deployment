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

export type DisconnectOptions = {
  keepalive?: boolean;
};

export type AgentStudioApi = {
  connect(token: string): Promise<ConnectResult>;
  disconnect(connectionId: string, options?: DisconnectOptions): Promise<void>;
  operation(
    connectionId: string,
    operation: string,
    payload: Record<string, unknown>,
  ): Promise<unknown>;
};

export type AgentStudioApiErrorCode =
  | "CONNECT_FAILED"
  | "DISCONNECT_FAILED"
  | "CONNECTION_EXPIRED"
  | "OPERATION_FAILED";

const ERROR_MESSAGES: Readonly<Record<AgentStudioApiErrorCode, string>> = {
  CONNECT_FAILED: "Connection failed",
  DISCONNECT_FAILED: "Disconnect failed",
  CONNECTION_EXPIRED: "Connection expired",
  OPERATION_FAILED: "Request failed",
};

export class AgentStudioApiError extends Error {
  constructor(readonly code: AgentStudioApiErrorCode) {
    super(ERROR_MESSAGES[code]);
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

async function post(fetcher: typeof fetch, body: string, keepalive = false): Promise<unknown> {
  const response = await fetcher("./api", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
    credentials: "omit",
    ...(keepalive ? { keepalive: true } : {}),
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

    async disconnect(connectionId, options) {
      try {
        const value = await post(
          fetcher,
          JSON.stringify({ action: "disconnect", connectionId }),
          options?.keepalive,
        );
        if (!isRecord(value) || value.ok !== true) throw new Error("invalid response");
      } catch {
        throw new AgentStudioApiError("DISCONNECT_FAILED");
      }
    },

    async operation(connectionId, operation, payload) {
      let value: unknown;
      try {
        value = await post(
          fetcher,
          JSON.stringify({ action: "operation", connectionId, operation, payload }),
        );
      } catch {
        throw new AgentStudioApiError("OPERATION_FAILED");
      }
      if (!isRecord(value)) throw new AgentStudioApiError("OPERATION_FAILED");
      if (value.ok === true) return value.data;
      const code = isRecord(value.error) ? value.error.code : undefined;
      throw new AgentStudioApiError(
        code === "CONNECTION_EXPIRED" ? "CONNECTION_EXPIRED" : "OPERATION_FAILED",
      );
    },
  };
}
