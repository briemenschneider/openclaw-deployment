import { describe, expect, it } from "vitest";
import {
  MAX_PANEL_REQUEST_BYTES,
  parsePanelRequest,
  ProtocolError,
} from "../src/protocol.js";

const connectionId = "a".repeat(64);

describe("panel protocol", () => {
  it("parses the closed connect, disconnect, and authenticated-operation union", () => {
    expect(parsePanelRequest(JSON.stringify({ action: "connect", token: "secret" }))).toEqual({
      action: "connect",
      token: "secret",
    });
    expect(
      parsePanelRequest(JSON.stringify({ action: "disconnect", connectionId })),
    ).toEqual({ action: "disconnect", connectionId });
    expect(
      parsePanelRequest(
        JSON.stringify({
          action: "operation",
          connectionId,
          operation: "agents.list",
          payload: { cursor: "next" },
        }),
      ),
    ).toEqual({
      action: "operation",
      connectionId,
      operation: "agents.list",
      payload: { cursor: "next" },
    });
  });

  it.each([
    { action: "unknown" },
    { action: "connect", token: "secret", extra: true },
    { action: "disconnect", connectionId: "A".repeat(64) },
    { action: "disconnect", connectionId, extra: true },
    { action: "operation", connectionId, operation: "", payload: {} },
    { action: "operation", connectionId, operation: "x".repeat(129), payload: {} },
    { action: "operation", connectionId, operation: "agents.list", payload: [] },
    { action: "operation", connectionId, operation: "agents.list", payload: {}, extra: true },
  ])("rejects unsupported, malformed, or open request data: $action", (value) => {
    expect(() => parsePanelRequest(JSON.stringify(value))).toThrow(ProtocolError);
  });

  it("rejects a valid JSON request whose UTF-8 representation exceeds 64 KiB", () => {
    const oversized = JSON.stringify({
      action: "connect",
      token: "é".repeat(MAX_PANEL_REQUEST_BYTES / 2),
    });

    expect(oversized.length).toBeLessThan(MAX_PANEL_REQUEST_BYTES);
    expect(() => parsePanelRequest(oversized)).toThrow(ProtocolError);
  });
});
