import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { PanelRequest } from "./protocol.js";

export type GatewayOperationClient = Pick<GatewayClient, "request">;

export const BROWSER_OPERATIONS = [
  "listAgents",
  "getAgent",
  "updateAgent",
  "listAgentFiles",
  "getAgentFile",
  "setAgentFile",
  "listModels",
  "listSessions",
  "createSession",
] as const;

export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];
export type GatewayOperationFeatures = Record<BrowserOperation, boolean>;

type GatewayOperationErrorCode =
  | "CONNECTION_EXPIRED"
  | "FEATURE_UNAVAILABLE"
  | "GATEWAY_REQUEST_FAILED"
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_OPERATION";

export type GatewayOperationResult =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: {
        code: GatewayOperationErrorCode;
        message: string;
      };
    };

const OPERATION_METHODS: Readonly<Record<BrowserOperation, string>> = {
  listAgents: "agents.list",
  getAgent: "agent.get",
  updateAgent: "agents.update",
  listAgentFiles: "agents.files.list",
  getAgentFile: "agents.files.get",
  setAgentFile: "agents.files.set",
  listModels: "models.list",
  listSessions: "sessions.list",
  createSession: "sessions.create",
};

const CORE_AGENT_FILES = new Set([
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
]);

const REDACTED_RESPONSE_KEY = /^(?:accessToken|agentRuntimeIdentityToken|apiKey|approvalRuntimeToken|authorization|authToken|bootstrapToken|cause|cookie|credential|credentials|details|deviceToken|password|privateKey|refreshToken|secret|stack|token)$/i;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function operationError(
  code: GatewayOperationErrorCode,
  message: string,
): GatewayOperationResult {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && hasOnlyKeys(value, expected);
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function isOptionalBoundedString(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): boolean {
  return !(key in value) || isBoundedString(value[key], min, max);
}

function isOptionalBoolean(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || typeof value[key] === "boolean";
}

function isOptionalInteger(
  value: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): boolean {
  if (!(key in value)) return true;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= min && candidate <= max;
}

function isAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID_PATTERN.test(value);
}

function copyKeys(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in value) copy[key] = value[key];
  }
  return copy;
}

function validatePayload(operation: BrowserOperation, payload: unknown): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;

  switch (operation) {
    case "listAgents":
      return hasExactlyKeys(payload, []) ? {} : undefined;
    case "getAgent":
    case "listAgentFiles":
      return hasExactlyKeys(payload, ["agentId"]) && isAgentId(payload.agentId)
        ? { agentId: payload.agentId }
        : undefined;
    case "updateAgent": {
      const keys = ["agentId", "name", "workspace", "model", "emoji", "avatar"] as const;
      if (
        !hasOnlyKeys(payload, keys) ||
        Object.keys(payload).length < 2 ||
        !isAgentId(payload.agentId) ||
        !isOptionalBoundedString(payload, "name", 1, 128) ||
        !isOptionalBoundedString(payload, "workspace", 1, 1_024) ||
        !isOptionalBoundedString(payload, "model", 1, 256) ||
        !isOptionalBoundedString(payload, "emoji", 0, 32) ||
        !isOptionalBoundedString(payload, "avatar", 0, 2_048)
      ) {
        return undefined;
      }
      return copyKeys(payload, keys);
    }
    case "getAgentFile": {
      if (
        !hasExactlyKeys(payload, ["agentId", "name"]) ||
        !isAgentId(payload.agentId) ||
        typeof payload.name !== "string" ||
        !CORE_AGENT_FILES.has(payload.name)
      ) {
        return undefined;
      }
      return { agentId: payload.agentId, name: payload.name };
    }
    case "setAgentFile": {
      if (
        !hasExactlyKeys(payload, ["agentId", "name", "content"]) ||
        !isAgentId(payload.agentId) ||
        typeof payload.name !== "string" ||
        !CORE_AGENT_FILES.has(payload.name) ||
        !isBoundedString(payload.content, 0, 60_000)
      ) {
        return undefined;
      }
      return { agentId: payload.agentId, name: payload.name, content: payload.content };
    }
    case "listModels": {
      if (!hasOnlyKeys(payload, ["view"])) return undefined;
      if (
        "view" in payload &&
        payload.view !== "default" &&
        payload.view !== "configured" &&
        payload.view !== "all"
      ) {
        return undefined;
      }
      return copyKeys(payload, ["view"]);
    }
    case "listSessions": {
      const keys = [
        "limit",
        "offset",
        "activeMinutes",
        "includeGlobal",
        "includeUnknown",
        "configuredAgentsOnly",
        "includeDerivedTitles",
        "includeLastMessage",
        "label",
        "spawnedBy",
        "agentId",
        "search",
        "archived",
      ] as const;
      if (
        !hasOnlyKeys(payload, keys) ||
        !isOptionalInteger(payload, "limit", 1, 200) ||
        !isOptionalInteger(payload, "offset", 0, 100_000) ||
        !isOptionalInteger(payload, "activeMinutes", 1, 525_600) ||
        !isOptionalBoolean(payload, "includeGlobal") ||
        !isOptionalBoolean(payload, "includeUnknown") ||
        !isOptionalBoolean(payload, "configuredAgentsOnly") ||
        !isOptionalBoolean(payload, "includeDerivedTitles") ||
        !isOptionalBoolean(payload, "includeLastMessage") ||
        !isOptionalBoolean(payload, "archived") ||
        !isOptionalBoundedString(payload, "label", 1, 256) ||
        !isOptionalBoundedString(payload, "spawnedBy", 1, 256) ||
        !isOptionalBoundedString(payload, "search", 1, 512) ||
        ("agentId" in payload && !isAgentId(payload.agentId))
      ) {
        return undefined;
      }
      return copyKeys(payload, keys);
    }
    case "createSession": {
      const keys = ["agentId", "label", "model", "task", "message", "worktree"] as const;
      if (
        !hasOnlyKeys(payload, keys) ||
        !isAgentId(payload.agentId) ||
        !isOptionalBoundedString(payload, "label", 1, 256) ||
        !isOptionalBoundedString(payload, "model", 1, 256) ||
        !isOptionalBoundedString(payload, "task", 1, 32_768) ||
        !isOptionalBoundedString(payload, "message", 1, 32_768) ||
        !isOptionalBoolean(payload, "worktree")
      ) {
        return undefined;
      }
      return copyKeys(payload, keys);
    }
  }
}

function browserOperation(value: string): BrowserOperation | undefined {
  switch (value) {
    case "listAgents":
    case "getAgent":
    case "updateAgent":
    case "listAgentFiles":
    case "getAgentFile":
    case "setAgentFile":
    case "listModels":
    case "listSessions":
    case "createSession":
      return value;
    default:
      return undefined;
  }
}

function sanitizedGatewayData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizedGatewayData(entry));
  if (!isRecord(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!REDACTED_RESPONSE_KEY.test(key)) sanitized[key] = sanitizedGatewayData(entry);
  }
  return sanitized;
}

export function deriveGatewayOperationFeatures(methods: readonly string[]): GatewayOperationFeatures {
  const advertised = new Set(methods);
  return {
    listAgents: advertised.has(OPERATION_METHODS.listAgents),
    getAgent: advertised.has(OPERATION_METHODS.getAgent),
    updateAgent: advertised.has(OPERATION_METHODS.updateAgent),
    listAgentFiles: advertised.has(OPERATION_METHODS.listAgentFiles),
    getAgentFile: advertised.has(OPERATION_METHODS.getAgentFile),
    setAgentFile: advertised.has(OPERATION_METHODS.setAgentFile),
    listModels: advertised.has(OPERATION_METHODS.listModels),
    listSessions: advertised.has(OPERATION_METHODS.listSessions),
    createSession: advertised.has(OPERATION_METHODS.createSession),
  };
}

export async function executeGatewayOperation(
  client: GatewayOperationClient,
  advertisedMethods: readonly string[] | ReadonlySet<string>,
  operationName: string,
  payload: unknown,
): Promise<GatewayOperationResult> {
  const operation = browserOperation(operationName);
  if (!operation) return operationError("UNSUPPORTED_OPERATION", "Unsupported operation");
  const method = OPERATION_METHODS[operation];
  const advertised = advertisedMethods instanceof Set ? advertisedMethods : new Set(advertisedMethods);
  if (!advertised.has(method)) return operationError("FEATURE_UNAVAILABLE", "Operation unavailable");
  const validatedPayload = validatePayload(operation, payload);
  if (!validatedPayload) return operationError("INVALID_PAYLOAD", "Invalid operation payload");

  try {
    const data = await client.request(method, validatedPayload);
    return { ok: true, data: sanitizedGatewayData(data) };
  } catch {
    return operationError("GATEWAY_REQUEST_FAILED", "Gateway request failed");
  }
}

type PanelOperationSession = {
  client: GatewayOperationClient;
  advertisedMethods: ReadonlySet<string>;
};

type PanelSessionAccess = {
  connect(token: string, sourceIp: string): Promise<unknown>;
  disconnect(connectionId: string): Promise<unknown>;
  getOperationSession(connectionId: string): PanelOperationSession | undefined;
};

export function createPanelRequestBroker(sessions: PanelSessionAccess): {
  handle(request: PanelRequest, sourceIp: string): Promise<unknown>;
} {
  return {
    async handle(request, sourceIp) {
      if (request.action === "connect") return await sessions.connect(request.token, sourceIp);
      if (request.action === "disconnect") return await sessions.disconnect(request.connectionId);
      const session = sessions.getOperationSession(request.connectionId);
      if (!session) return operationError("CONNECTION_EXPIRED", "Connection expired");
      return await executeGatewayOperation(
        session.client,
        session.advertisedMethods,
        request.operation,
        request.payload,
      );
    },
  };
}
