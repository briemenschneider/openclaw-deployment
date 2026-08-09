import { randomBytes } from "node:crypto";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import {
  deriveGatewayOperationFeatures,
  type GatewayOperationFeatures,
} from "./gateway-operations.js";

type GatewayClientOptions = ConstructorParameters<typeof GatewayClient>[0];

export const PANEL_IDLE_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_GLOBAL_CONNECTION_LIMIT = 32;
export const DEFAULT_PER_IP_CONNECTION_LIMIT = 4;
export const DEFAULT_ATTEMPT_LIMIT = 5;
export const DEFAULT_ATTEMPT_WINDOW_MS = 60_000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export type GatewayClientLike = Pick<GatewayClient, "request" | "start" | "stopAndWait">;
export type GatewayClientFactory = (options: GatewayClientOptions) => GatewayClientLike;

export type PanelSessionLimits = {
  globalConnections: number;
  perIpConnections: number;
  attemptsPerWindow: number;
  attemptWindowMs: number;
};

export type PanelSessionBrokerOptions = {
  gatewayUrl: string;
  createGatewayClient?: GatewayClientFactory;
  log?: (event: PanelSessionLogEvent) => void;
  limits?: Partial<PanelSessionLimits>;
  connectTimeoutMs?: number;
};

export type PanelSessionLogEvent =
  | { action: "connect" }
  | { action: "connect"; connectionId: string }
  | { action: "disconnect"; connectionId: string };

type BrokerErrorCode =
  | "AUTHENTICATION_FAILED"
  | "CONNECTION_EXPIRED"
  | "CONNECTION_LIMIT"
  | "RATE_LIMITED";

type BrokerErrorResult = {
  ok: false;
  error: { code: BrokerErrorCode; message: string };
};

export type ConnectResult =
  | { ok: true; connectionId: string; features: GatewayOperationFeatures }
  | BrokerErrorResult;
export type DisconnectResult = { ok: true } | BrokerErrorResult;

type PanelSession = {
  client: GatewayClientLike;
  advertisedMethods: ReadonlySet<string>;
  sourceIp: string;
  idleTimer?: ReturnType<typeof setTimeout>;
};

function errorResult(code: BrokerErrorCode, message: string): BrokerErrorResult {
  return { ok: false, error: { code, message } };
}

function assertLoopbackGatewayUrl(rawUrl: string): void {
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

export class PanelSessionBroker {
  readonly #gatewayUrl: string;
  readonly #createGatewayClient: GatewayClientFactory;
  readonly #log: (event: PanelSessionLogEvent) => void;
  readonly #limits: PanelSessionLimits;
  readonly #connectTimeoutMs: number;
  readonly #sessions = new Map<string, PanelSession>();
  readonly #pendingByIp = new Map<string, number>();
  readonly #attemptsByIp = new Map<string, number[]>();
  readonly #pendingRejects = new Map<GatewayClientLike, (error: Error) => void>();
  readonly #stoppedClients = new WeakSet<object>();
  #pendingTotal = 0;
  #closed = false;

  constructor(options: PanelSessionBrokerOptions) {
    assertLoopbackGatewayUrl(options.gatewayUrl);
    this.#gatewayUrl = options.gatewayUrl;
    this.#createGatewayClient =
      options.createGatewayClient ?? ((clientOptions) => new GatewayClient(clientOptions));
    this.#log = (event) => {
      try {
        options.log?.(event);
      } catch {
        // Logging must never own or interrupt client/session lifecycle.
      }
    };
    this.#limits = {
      globalConnections: options.limits?.globalConnections ?? DEFAULT_GLOBAL_CONNECTION_LIMIT,
      perIpConnections: options.limits?.perIpConnections ?? DEFAULT_PER_IP_CONNECTION_LIMIT,
      attemptsPerWindow: options.limits?.attemptsPerWindow ?? DEFAULT_ATTEMPT_LIMIT,
      attemptWindowMs: options.limits?.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS,
    };
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async connect(token: string, sourceIp: string): Promise<ConnectResult> {
    if (this.#closed || !this.#recordAttempt(sourceIp)) {
      this.#log({ action: "connect" });
      return errorResult("RATE_LIMITED", "Too many connection attempts");
    }
    if (!this.#hasCapacity(sourceIp)) {
      this.#log({ action: "connect" });
      return errorResult("CONNECTION_LIMIT", "Connection limit reached");
    }

    this.#reserve(sourceIp);
    let credential: string | undefined = token;
    let resolveHello!: () => void;
    let rejectHello!: (error: Error) => void;
    let connectionId: string | undefined;
    let advertisedMethods = new Set<string>();
    let closedBeforeRegistration = false;
    const hello = new Promise<void>((resolve, reject) => {
      resolveHello = resolve;
      rejectHello = reject;
    });
    const clientOptions: GatewayClientOptions = {
      url: this.#gatewayUrl,
      token: credential,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      clientName: "gateway-client",
      mode: "backend",
      deviceIdentity: null,
      hostDeps: {
        logDebug: () => undefined,
        logError: () => undefined,
        redactForLog: () => "[redacted]",
      },
      onHelloOk: (hello) => {
        advertisedMethods = new Set(hello.features.methods);
        resolveHello();
      },
      onConnectError: (error) => rejectHello(error),
      onClose: () => {
        if (connectionId) {
          this.#dropClosedSession(connectionId);
        } else {
          closedBeforeRegistration = true;
          rejectHello(new Error("Gateway connection closed"));
        }
      },
    };

    let client: GatewayClientLike | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      client = this.#createGatewayClient(clientOptions);
      this.#pendingRejects.set(client, rejectHello);
      connectTimer = setTimeout(
        () => rejectHello(new Error("Gateway authentication timed out")),
        this.#connectTimeoutMs,
      );
      client.start();
      await hello;
      token = "";
      credential = undefined;
      clientOptions.token = undefined;
      if (closedBeforeRegistration || this.#closed) throw new Error("Gateway connection closed");

      connectionId = this.#newConnectionId();
      const session: PanelSession = {
        client,
        advertisedMethods,
        sourceIp,
      };
      this.#sessions.set(connectionId, session);
      this.#scheduleIdleExpiry(connectionId, session);
      this.#log({ action: "connect", connectionId });
      return {
        ok: true,
        connectionId,
        features: deriveGatewayOperationFeatures([...advertisedMethods]),
      };
    } catch {
      if (client) await this.#stopClient(client);
      this.#log({ action: "connect" });
      return errorResult("AUTHENTICATION_FAILED", "Authentication failed");
    } finally {
      credential = undefined;
      clientOptions.token = undefined;
      if (connectTimer) clearTimeout(connectTimer);
      if (client) this.#pendingRejects.delete(client);
      this.#release(sourceIp);
    }
  }

  getClient(connectionId: string): GatewayClientLike | undefined {
    return this.getOperationSession(connectionId)?.client;
  }

  getOperationSession(
    connectionId: string,
  ): { client: GatewayClientLike; advertisedMethods: ReadonlySet<string> } | undefined {
    const session = this.#sessions.get(connectionId);
    if (!session) return undefined;
    this.#scheduleIdleExpiry(connectionId, session);
    return { client: session.client, advertisedMethods: session.advertisedMethods };
  }

  async disconnect(connectionId: string): Promise<DisconnectResult> {
    const session = this.#sessions.get(connectionId);
    if (!session) return errorResult("CONNECTION_EXPIRED", "Connection expired");
    this.#sessions.delete(connectionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.#log({ action: "disconnect", connectionId });
    await this.#stopClient(session.client);
    return { ok: true };
  }

  snapshot(): { activeConnections: number } {
    return { activeConnections: this.#sessions.size };
  }

  async shutdown(): Promise<void> {
    if (this.#closed && this.#sessions.size === 0 && this.#pendingRejects.size === 0) return;
    this.#closed = true;
    const clients = new Set<GatewayClientLike>();
    for (const session of this.#sessions.values()) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      clients.add(session.client);
    }
    this.#sessions.clear();
    for (const [client, reject] of this.#pendingRejects) {
      reject(new Error("Panel session broker shut down"));
      clients.add(client);
    }
    this.#pendingRejects.clear();
    this.#attemptsByIp.clear();
    await Promise.all([...clients].map((client) => this.#stopClient(client)));
  }

  #recordAttempt(sourceIp: string): boolean {
    const now = Date.now();
    for (const [ip, attempts] of this.#attemptsByIp) {
      const recent = attempts.filter((time) => now - time < this.#limits.attemptWindowMs);
      if (recent.length === 0) this.#attemptsByIp.delete(ip);
      else if (recent.length !== attempts.length) this.#attemptsByIp.set(ip, recent);
    }
    const attempts = this.#attemptsByIp.get(sourceIp) ?? [];
    if (attempts.length >= this.#limits.attemptsPerWindow) return false;
    attempts.push(now);
    this.#attemptsByIp.set(sourceIp, attempts);
    if (this.#attemptsByIp.size > 1024) {
      const oldest = this.#attemptsByIp.keys().next().value as string | undefined;
      if (oldest && oldest !== sourceIp) this.#attemptsByIp.delete(oldest);
    }
    return true;
  }

  #hasCapacity(sourceIp: string): boolean {
    if (this.#sessions.size + this.#pendingTotal >= this.#limits.globalConnections) return false;
    let activeForIp = 0;
    for (const session of this.#sessions.values()) {
      if (session.sourceIp === sourceIp) activeForIp += 1;
    }
    return activeForIp + (this.#pendingByIp.get(sourceIp) ?? 0) < this.#limits.perIpConnections;
  }

  #reserve(sourceIp: string): void {
    this.#pendingTotal += 1;
    this.#pendingByIp.set(sourceIp, (this.#pendingByIp.get(sourceIp) ?? 0) + 1);
  }

  #release(sourceIp: string): void {
    this.#pendingTotal -= 1;
    const next = (this.#pendingByIp.get(sourceIp) ?? 1) - 1;
    if (next === 0) this.#pendingByIp.delete(sourceIp);
    else this.#pendingByIp.set(sourceIp, next);
  }

  #newConnectionId(): string {
    let id: string;
    do id = randomBytes(32).toString("hex");
    while (this.#sessions.has(id));
    return id;
  }

  #scheduleIdleExpiry(connectionId: string, session: PanelSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(async () => {
      if (this.#sessions.get(connectionId) !== session) return;
      this.#sessions.delete(connectionId);
      await this.#stopClient(session.client);
    }, PANEL_IDLE_TIMEOUT_MS);
  }

  #dropClosedSession(connectionId: string): void {
    const session = this.#sessions.get(connectionId);
    if (!session) return;
    this.#sessions.delete(connectionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    void this.#stopClient(session.client);
  }

  async #stopClient(client: GatewayClientLike): Promise<void> {
    if (this.#stoppedClients.has(client)) return;
    this.#stoppedClients.add(client);
    await client.stopAndWait().catch(() => undefined);
  }
}
