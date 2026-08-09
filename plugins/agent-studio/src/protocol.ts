export const MAX_PANEL_REQUEST_BYTES = 64 * 1024;
export const CONNECTION_ID_PATTERN = /^[0-9a-f]{64}$/;

export type ConnectRequest = {
  action: "connect";
  token: string;
};

export type DisconnectRequest = {
  action: "disconnect";
  connectionId: string;
};

export type OperationRequest = {
  action: "operation";
  connectionId: string;
  operation: string;
  payload: Record<string, unknown>;
};

export type PanelRequest = ConnectRequest | DisconnectRequest | OperationRequest;

export class ProtocolError extends Error {
  readonly code = "INVALID_REQUEST";

  constructor() {
    super("Invalid panel request");
    this.name = "ProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isConnectionId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ID_PATTERN.test(value);
}

export function parsePanelRequest(raw: string): PanelRequest {
  if (Buffer.byteLength(raw, "utf8") > MAX_PANEL_REQUEST_BYTES) {
    throw new ProtocolError();
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError();
  }

  if (!isRecord(value) || typeof value.action !== "string") {
    throw new ProtocolError();
  }

  if (value.action === "connect") {
    if (
      !hasExactlyKeys(value, ["action", "token"]) ||
      typeof value.token !== "string" ||
      value.token.length === 0
    ) {
      throw new ProtocolError();
    }
    return { action: "connect", token: value.token };
  }

  if (value.action === "disconnect") {
    if (!hasExactlyKeys(value, ["action", "connectionId"]) || !isConnectionId(value.connectionId)) {
      throw new ProtocolError();
    }
    return { action: "disconnect", connectionId: value.connectionId };
  }

  if (value.action === "operation") {
    if (
      !hasExactlyKeys(value, ["action", "connectionId", "operation", "payload"]) ||
      !isConnectionId(value.connectionId) ||
      typeof value.operation !== "string" ||
      value.operation.length === 0 ||
      value.operation.length > 128 ||
      !isRecord(value.payload)
    ) {
      throw new ProtocolError();
    }
    return {
      action: "operation",
      connectionId: value.connectionId,
      operation: value.operation,
      payload: value.payload,
    };
  }

  throw new ProtocolError();
}
import { Buffer } from "node:buffer";
