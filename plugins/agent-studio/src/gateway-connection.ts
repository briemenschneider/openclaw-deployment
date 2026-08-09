import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { EventFrame } from "openclaw/plugin-sdk/gateway-runtime";

type SocketData = { toString(): string };
type SocketError = Error;
type SocketLike = {
  readyState: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: SocketData) => void): void;
  on(event: "close", listener: (code: number, reason: SocketData) => void): void;
  on(event: "error", listener: (error: SocketError) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
};
type SocketConstructor = {
  new (url: string): SocketLike;
  CLOSED: number;
  CLOSING: number;
};

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as SocketConstructor;

export type GatewayConnectionRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  onAccepted?: (payload: unknown) => void;
};

export type GatewayConnectionClient = {
  start(): void;
  stopAndWait(): Promise<void>;
  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    options?: GatewayConnectionRequestOptions,
  ): Promise<T>;
};

export type LoopbackGatewayConnectionOptions = {
  url: string;
  token: string | undefined;
  scopes: readonly ["operator.read", "operator.write"];
  onHelloOk?: (hello: unknown) => void;
  onConnectError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
};

type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
};

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  expectFinal: boolean;
  onAccepted?: (payload: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertLoopbackWebSocketUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Gateway URL must use loopback WebSocket transport");
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !loopback || url.username || url.password) {
    throw new Error("Gateway URL must use loopback WebSocket transport");
  }
}

function stableError(message: string): Error {
  const error = new Error(message);
  error.name = "GatewayConnectionError";
  return error;
}

function parseFrame(data: SocketData): unknown {
  try {
    return JSON.parse(data.toString()) as unknown;
  } catch {
    return undefined;
  }
}

function isResponseFrame(value: unknown): value is ResponseFrame {
  return (
    isRecord(value) &&
    value.type === "res" &&
    typeof value.id === "string" &&
    typeof value.ok === "boolean"
  );
}

function isHelloOk(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "hello-ok" || !isRecord(value.auth)) return false;
  if (value.auth.role !== "operator" || !Array.isArray(value.auth.scopes)) return false;
  return value.auth.scopes.includes("operator.read") && value.auth.scopes.includes("operator.write");
}

export class LoopbackGatewayConnection implements GatewayConnectionClient {
  readonly #url: string;
  readonly #scopes: readonly ["operator.read", "operator.write"];
  readonly #onHelloOk?: (hello: unknown) => void;
  readonly #onConnectError?: (error: Error) => void;
  readonly #onClose?: (code: number, reason: string) => void;
  readonly #pending = new Map<string, PendingRequest>();
  #credential: string | undefined;
  #socket: SocketLike | undefined;
  #started = false;
  #stopped = false;
  #authenticated = false;
  #connectSent = false;
  #connectFailureNotified = false;
  #closeNotified = false;
  #stopPromise: Promise<void> | undefined;
  #resolveStop: (() => void) | undefined;
  #terminateTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: LoopbackGatewayConnectionOptions) {
    assertLoopbackWebSocketUrl(options.url);
    this.#url = options.url;
    this.#credential = options.token;
    this.#scopes = [...options.scopes];
    this.#onHelloOk = options.onHelloOk;
    this.#onConnectError = options.onConnectError;
    this.#onClose = options.onClose;
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    let credential = this.#credential;
    this.#credential = undefined;
    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.on("message", (data) => {
      const frame = parseFrame(data);
      if (!this.#connectSent && isRecord(frame) && frame.type === "event" && frame.event === "connect.challenge") {
        const event = frame as EventFrame;
        const nonce = isRecord(event.payload) && typeof event.payload.nonce === "string"
          ? event.payload.nonce.trim()
          : "";
        if (!nonce || !credential) {
          credential = undefined;
          this.#failAuthentication();
          return;
        }
        this.#connectSent = true;
        const connectPromise = this.#sendRequest("connect", {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "gateway-client",
            version: "0.1.0",
            platform: process.platform,
            mode: "backend",
          },
          caps: [],
          auth: { token: credential },
          role: "operator",
          scopes: [...this.#scopes],
        }, { timeoutMs: null });
        credential = undefined;
        connectPromise.then((hello) => {
          if (!isHelloOk(hello)) {
            this.#failAuthentication();
            return;
          }
          this.#authenticated = true;
          try {
            this.#onHelloOk?.(hello);
          } catch {
            // Consumer callbacks do not own transport lifecycle.
          }
        }).catch(() => this.#failAuthentication());
        return;
      }
      this.#handleFrame(frame);
    });
    socket.on("close", (code, reason) => {
      credential = undefined;
      if (this.#socket === socket) this.#socket = undefined;
      this.#rejectPending(stableError("Gateway connection closed"));
      if (!this.#authenticated && !this.#stopped) this.#notifyConnectError();
      this.#notifyClose(code, reason.toString());
      this.#finishStop();
    });
    socket.on("error", () => {
      if (!this.#authenticated) this.#notifyConnectError();
    });
  }

  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    options?: GatewayConnectionRequestOptions,
  ): Promise<T> {
    if (!this.#authenticated || this.#stopped) {
      return Promise.reject(stableError("Gateway connection unavailable"));
    }
    return this.#sendRequest(method, params, options) as Promise<T>;
  }

  async stopAndWait(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopped = true;
    this.#credential = undefined;
    this.#rejectPending(stableError("Gateway connection stopped"));
    const socket = this.#socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    this.#stopPromise = new Promise<void>((resolve) => {
      this.#resolveStop = resolve;
    });
    this.#terminateTimer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        this.#finishStop();
      }
    }, 1_000);
    this.#terminateTimer.unref?.();
    try {
      if (socket.readyState === WebSocket.CLOSING) return this.#stopPromise;
      socket.close();
    } catch {
      socket.terminate();
    }
    return this.#stopPromise;
  }

  #sendRequest(
    method: string,
    params: unknown,
    options?: GatewayConnectionRequestOptions,
  ): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || this.#stopped) return Promise.reject(stableError("Gateway connection unavailable"));
    const id = randomUUID();
    const timeoutMs = options?.timeoutMs === undefined ? 30_000 : options.timeoutMs;
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        expectFinal: options?.expectFinal === true,
        onAccepted: options?.onAccepted,
      };
      if (typeof timeoutMs === "number" && timeoutMs >= 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          pending.removeAbort?.();
          reject(stableError("Gateway request timed out"));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      if (options?.signal) {
        const abort = () => {
          this.#pending.delete(id);
          if (pending.timer) clearTimeout(pending.timer);
          reject(stableError("Gateway request cancelled"));
        };
        options.signal.addEventListener("abort", abort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener("abort", abort);
      }
      this.#pending.set(id, pending);
    });
    try {
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    } catch {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        this.#cleanupPending(pending);
        pending.reject(stableError("Gateway connection unavailable"));
      }
    }
    return promise;
  }

  #handleFrame(frame: unknown): void {
    if (!isResponseFrame(frame)) return;
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    if (pending.expectFinal && isRecord(frame.payload) && frame.payload.status === "accepted") {
      try {
        pending.onAccepted?.(frame.payload);
      } catch {
        // Consumer callbacks do not own transport lifecycle.
      }
      return;
    }
    this.#pending.delete(frame.id);
    this.#cleanupPending(pending);
    if (frame.ok) pending.resolve(frame.payload);
    else pending.reject(stableError("Gateway request failed"));
  }

  #failAuthentication(): void {
    this.#credential = undefined;
    this.#notifyConnectError();
    try {
      this.#socket?.close(1008, "authentication failed");
    } catch {
      this.#socket?.terminate();
    }
  }

  #notifyConnectError(): void {
    if (this.#connectFailureNotified) return;
    this.#connectFailureNotified = true;
    try {
      this.#onConnectError?.(stableError("Gateway authentication failed"));
    } catch {
      // Consumer callbacks do not own transport lifecycle.
    }
  }

  #notifyClose(code: number, reason: string): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    try {
      this.#onClose?.(code, reason);
    } catch {
      // Consumer callbacks do not own transport lifecycle.
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      this.#cleanupPending(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #cleanupPending(pending: PendingRequest): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.removeAbort?.();
  }

  #finishStop(): void {
    if (this.#terminateTimer) clearTimeout(this.#terminateTimer);
    this.#terminateTimer = undefined;
    this.#resolveStop?.();
    this.#resolveStop = undefined;
  }
}
