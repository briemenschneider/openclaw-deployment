import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, extname, sep, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer as Buffer$1 } from "node:buffer";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
const STATE_VERSION = 1;
const PLUGIN_STATE_DIRECTORY = "agent-studio";
const COLORS_FILE = "colors.json";
const AGENT_ID_PATTERN$1 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
class ColorStoreClosedError extends Error {
  constructor() {
    super("Color state unavailable");
    this.code = "COLOR_STORE_CLOSED";
    this.name = "ColorStoreClosedError";
  }
}
function emptyState() {
  return { version: STATE_VERSION, agents: {} };
}
function isRecord$2(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isAgentId$1(value) {
  return typeof value === "string" && AGENT_ID_PATTERN$1.test(value);
}
function normalizeAgentColor(value) {
  return typeof value === "string" && COLOR_PATTERN.test(value) ? value.toLowerCase() : void 0;
}
function parseState(value) {
  if (!isRecord$2(value) || value.version !== STATE_VERSION || !isRecord$2(value.agents)) return void 0;
  const agents = {};
  for (const [agentId, color] of Object.entries(value.agents)) {
    const normalized = normalizeAgentColor(color);
    if (!isAgentId$1(agentId) || !normalized) return void 0;
    agents[agentId] = normalized;
  }
  return { version: STATE_VERSION, agents };
}
function cloneAgents(agents) {
  return { ...agents };
}
class AgentColorStore {
  #directory;
  #stateFile;
  #fileSystem;
  #mutationQueue = Promise.resolve();
  #closed = false;
  #shutdownPromise;
  constructor(stateDir, options = {}) {
    this.#directory = join(stateDir, PLUGIN_STATE_DIRECTORY);
    this.#stateFile = join(this.#directory, COLORS_FILE);
    this.#fileSystem = options.fileSystem ?? fs;
  }
  async list() {
    this.#throwIfClosed();
    return await this.#serialize(async () => cloneAgents(await this.#readState().then((state) => state.agents)));
  }
  async set(agentId, color) {
    this.#throwIfClosed();
    const normalized = normalizeAgentColor(color);
    if (!isAgentId$1(agentId) || !normalized) return { ok: false };
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
  async shutdown() {
    if (this.#shutdownPromise) return await this.#shutdownPromise;
    this.#closed = true;
    this.#shutdownPromise = this.#mutationQueue.then(
      () => void 0,
      () => void 0
    );
    return await this.#shutdownPromise;
  }
  async #readState() {
    try {
      const raw = await this.#fileSystem.readFile(this.#stateFile, "utf8");
      return parseState(JSON.parse(raw)) ?? emptyState();
    } catch {
      return emptyState();
    }
  }
  async #writeState(state) {
    await this.#fileSystem.mkdir(this.#directory, { recursive: true });
    const temporaryFile = join(
      this.#directory,
      `.${COLORS_FILE}.${randomBytes(16).toString("hex")}.tmp`
    );
    let fileHandle;
    let renamed = false;
    try {
      fileHandle = await this.#fileSystem.open(temporaryFile, "wx", 384);
      await fileHandle.writeFile(`${JSON.stringify(state)}
`, "utf8");
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = void 0;
      await this.#fileSystem.rename(temporaryFile, this.#stateFile);
      renamed = true;
      await this.#syncDirectory();
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => void 0);
      if (!renamed) await this.#fileSystem.unlink(temporaryFile).catch(() => void 0);
    }
  }
  async #syncDirectory() {
    let directoryHandle;
    try {
      directoryHandle = await this.#fileSystem.open(this.#directory, "r");
      await directoryHandle.sync();
    } catch {
    } finally {
      await directoryHandle?.close().catch(() => void 0);
    }
  }
  async #serialize(operation) {
    const result = this.#mutationQueue.then(operation, operation);
    this.#mutationQueue = result.then(
      () => void 0,
      () => void 0
    );
    return await result;
  }
  #throwIfClosed() {
    if (this.#closed) throw new ColorStoreClosedError();
  }
}
const OPERATION_METHODS = {
  listAgents: "agents.list",
  updateAgent: "agents.update",
  listAgentFiles: "agents.files.list",
  getAgentFile: "agents.files.get",
  setAgentFile: "agents.files.set",
  listModels: "models.list",
  listSessions: "sessions.list",
  createSession: "sessions.create"
};
const CORE_AGENT_FILES = /* @__PURE__ */ new Set([
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md"
]);
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function operationError(code, message) {
  return { ok: false, error: { code, message } };
}
function isRecord$1(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasOnlyKeys(value, allowed) {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}
function hasExactlyKeys$1(value, expected) {
  return Object.keys(value).length === expected.length && hasOnlyKeys(value, expected);
}
function isBoundedString(value, min, max) {
  return typeof value === "string" && value.length >= min && value.length <= max;
}
function isOptionalBoundedString(value, key, min, max) {
  return !(key in value) || isBoundedString(value[key], min, max);
}
function isOptionalBoolean(value, key) {
  return !(key in value) || typeof value[key] === "boolean";
}
function isOptionalInteger(value, key, min, max) {
  if (!(key in value)) return true;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isInteger(candidate) && candidate >= min && candidate <= max;
}
function isAgentId(value) {
  return typeof value === "string" && AGENT_ID_PATTERN.test(value);
}
function copyKeys(value, keys) {
  const copy = {};
  for (const key of keys) {
    if (key in value) copy[key] = value[key];
  }
  return copy;
}
function validatePayload(operation, payload) {
  if (!isRecord$1(payload)) return void 0;
  switch (operation) {
    case "listAgents":
      return hasExactlyKeys$1(payload, []) ? {} : void 0;
    case "listAgentFiles":
      return hasExactlyKeys$1(payload, ["agentId"]) && isAgentId(payload.agentId) ? { agentId: payload.agentId } : void 0;
    case "updateAgent": {
      const keys = ["agentId", "name", "workspace", "model", "emoji", "avatar"];
      if (!hasOnlyKeys(payload, keys) || Object.keys(payload).length < 2 || !isAgentId(payload.agentId) || !isOptionalBoundedString(payload, "name", 1, 128) || !isOptionalBoundedString(payload, "workspace", 1, 1024) || !isOptionalBoundedString(payload, "model", 1, 256) || !isOptionalBoundedString(payload, "emoji", 0, 32) || !isOptionalBoundedString(payload, "avatar", 0, 2048)) {
        return void 0;
      }
      return copyKeys(payload, keys);
    }
    case "getAgentFile": {
      if (!hasExactlyKeys$1(payload, ["agentId", "name"]) || !isAgentId(payload.agentId) || typeof payload.name !== "string" || !CORE_AGENT_FILES.has(payload.name)) {
        return void 0;
      }
      return { agentId: payload.agentId, name: payload.name };
    }
    case "setAgentFile": {
      if (!hasExactlyKeys$1(payload, ["agentId", "name", "content"]) || !isAgentId(payload.agentId) || typeof payload.name !== "string" || !CORE_AGENT_FILES.has(payload.name) || !isBoundedString(payload.content, 0, 6e4)) {
        return void 0;
      }
      return { agentId: payload.agentId, name: payload.name, content: payload.content };
    }
    case "listModels": {
      if (!hasOnlyKeys(payload, ["view"])) return void 0;
      if ("view" in payload && payload.view !== "default" && payload.view !== "configured" && payload.view !== "all") {
        return void 0;
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
        "archived"
      ];
      if (!hasOnlyKeys(payload, keys) || !isOptionalInteger(payload, "limit", 1, 200) || !isOptionalInteger(payload, "offset", 0, 1e5) || !isOptionalInteger(payload, "activeMinutes", 1, 525600) || !isOptionalBoolean(payload, "includeGlobal") || !isOptionalBoolean(payload, "includeUnknown") || !isOptionalBoolean(payload, "configuredAgentsOnly") || !isOptionalBoolean(payload, "includeDerivedTitles") || !isOptionalBoolean(payload, "includeLastMessage") || !isOptionalBoolean(payload, "archived") || !isOptionalBoundedString(payload, "label", 1, 256) || !isOptionalBoundedString(payload, "spawnedBy", 1, 256) || !isOptionalBoundedString(payload, "search", 1, 512) || "agentId" in payload && !isAgentId(payload.agentId)) {
        return void 0;
      }
      return copyKeys(payload, keys);
    }
    case "createSession": {
      const keys = ["agentId", "label", "model", "task", "message", "worktree"];
      if (!hasOnlyKeys(payload, keys) || !isAgentId(payload.agentId) || !isOptionalBoundedString(payload, "label", 1, 256) || !isOptionalBoundedString(payload, "model", 1, 256) || !isOptionalBoundedString(payload, "task", 1, 32768) || !isOptionalBoundedString(payload, "message", 1, 32768) || !isOptionalBoolean(payload, "worktree")) {
        return void 0;
      }
      return copyKeys(payload, keys);
    }
  }
}
function browserOperation(value) {
  switch (value) {
    case "listAgents":
    case "updateAgent":
    case "listAgentFiles":
    case "getAgentFile":
    case "setAgentFile":
    case "listModels":
    case "listSessions":
    case "createSession":
      return value;
    default:
      return void 0;
  }
}
function copyString(source, target, key) {
  if (typeof source[key] === "string") target[key] = source[key];
}
function copyBoolean(source, target, key) {
  if (typeof source[key] === "boolean") target[key] = source[key];
}
function copyNumber(source, target, key) {
  if (typeof source[key] === "number" && Number.isFinite(source[key])) {
    target[key] = source[key];
  }
}
function copyNullableNumber(source, target, key) {
  if (source[key] === null) target[key] = null;
  else copyNumber(source, target, key);
}
function copyStringArray(source, target, key) {
  const value = source[key];
  if (Array.isArray(value)) target[key] = value.filter((entry) => typeof entry === "string");
}
function projectAgentIdentity(value) {
  if (!isRecord$1(value)) return void 0;
  const result = {};
  for (const key of ["name", "theme", "emoji", "avatar", "avatarUrl"]) copyString(value, result, key);
  return Object.keys(result).length > 0 ? result : void 0;
}
function projectAgentModel(value) {
  if (!isRecord$1(value)) return void 0;
  const result = {};
  copyString(value, result, "primary");
  copyStringArray(value, result, "fallbacks");
  return Object.keys(result).length > 0 ? result : void 0;
}
function projectAgent(value) {
  if (!isRecord$1(value) || typeof value.id !== "string") return void 0;
  const result = { id: value.id };
  copyString(value, result, "name");
  copyBoolean(value, result, "workspaceGit");
  const identity = projectAgentIdentity(value.identity);
  if (identity) result.identity = identity;
  const model = projectAgentModel(value.model);
  if (model) result.model = model;
  return result;
}
function projectAgentsList(value) {
  if (!isRecord$1(value)) return {};
  const result = {};
  copyString(value, result, "defaultId");
  if (Array.isArray(value.agents)) {
    result.agents = value.agents.map(projectAgent).filter((entry) => entry !== void 0);
  }
  return result;
}
function projectAgentUpdate(value) {
  if (!isRecord$1(value)) return {};
  const result = {};
  copyBoolean(value, result, "ok");
  copyString(value, result, "agentId");
  return result;
}
function projectAgentFile(value, includeContent) {
  if (!isRecord$1(value) || typeof value.name !== "string") return void 0;
  const result = { name: value.name };
  copyBoolean(value, result, "missing");
  copyNumber(value, result, "size");
  copyNumber(value, result, "updatedAtMs");
  if (includeContent) copyString(value, result, "content");
  return result;
}
function projectAgentFilesList(value) {
  if (!isRecord$1(value)) return {};
  const result = {};
  copyString(value, result, "agentId");
  if (Array.isArray(value.files)) {
    result.files = value.files.map((entry) => projectAgentFile(entry, false)).filter((entry) => entry !== void 0);
  }
  return result;
}
function projectAgentFileResult(value, includeOk) {
  if (!isRecord$1(value)) return {};
  const result = {};
  if (includeOk) copyBoolean(value, result, "ok");
  copyString(value, result, "agentId");
  const file = projectAgentFile(value.file, true);
  if (file) result.file = file;
  return result;
}
function projectModel(value) {
  if (!isRecord$1(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.provider !== "string") {
    return void 0;
  }
  const result = {
    id: value.id,
    name: value.name,
    provider: value.provider
  };
  copyString(value, result, "alias");
  copyBoolean(value, result, "available");
  copyNumber(value, result, "contextWindow");
  copyBoolean(value, result, "reasoning");
  return result;
}
function projectModelsList(value) {
  if (!isRecord$1(value)) return {};
  const result = {};
  if (Array.isArray(value.models)) {
    result.models = value.models.map(projectModel).filter((entry) => entry !== void 0);
  }
  return result;
}
function projectSession(value) {
  if (!isRecord$1(value) || typeof value.key !== "string") return void 0;
  const result = { key: value.key };
  for (const key of [
    "agentId",
    "sessionId",
    "kind",
    "label",
    "displayName",
    "status",
    "modelProvider",
    "model"
  ]) {
    copyString(value, result, key);
  }
  for (const key of ["archived", "pinned", "unread", "hasActiveRun"]) {
    copyBoolean(value, result, key);
  }
  for (const key of ["updatedAt", "startedAt", "endedAt", "totalTokens"]) {
    copyNumber(value, result, key);
  }
  return result;
}
function projectSessionsList(value) {
  if (!isRecord$1(value)) return {};
  const result = {};
  for (const key of ["count", "totalCount", "limitApplied", "offset"]) copyNumber(value, result, key);
  copyNullableNumber(value, result, "nextOffset");
  copyBoolean(value, result, "hasMore");
  if (Array.isArray(value.sessions)) {
    result.sessions = value.sessions.map(projectSession).filter((entry) => entry !== void 0);
  }
  return result;
}
function projectSessionCreate(value) {
  if (!isRecord$1(value)) return {};
  const result = {};
  copyBoolean(value, result, "ok");
  copyString(value, result, "key");
  copyString(value, result, "sessionId");
  copyBoolean(value, result, "runStarted");
  copyString(value, result, "status");
  return result;
}
function projectGatewayData(operation, value) {
  switch (operation) {
    case "listAgents":
      return projectAgentsList(value);
    case "updateAgent":
      return projectAgentUpdate(value);
    case "listAgentFiles":
      return projectAgentFilesList(value);
    case "getAgentFile":
      return projectAgentFileResult(value, false);
    case "setAgentFile":
      return projectAgentFileResult(value, true);
    case "listModels":
      return projectModelsList(value);
    case "listSessions":
      return projectSessionsList(value);
    case "createSession":
      return projectSessionCreate(value);
  }
}
function deriveGatewayOperationFeatures(methods) {
  const advertised = new Set(methods);
  return {
    listAgents: advertised.has(OPERATION_METHODS.listAgents),
    updateAgent: advertised.has(OPERATION_METHODS.updateAgent),
    listAgentFiles: advertised.has(OPERATION_METHODS.listAgentFiles),
    getAgentFile: advertised.has(OPERATION_METHODS.getAgentFile),
    setAgentFile: advertised.has(OPERATION_METHODS.setAgentFile),
    listModels: advertised.has(OPERATION_METHODS.listModels),
    listSessions: advertised.has(OPERATION_METHODS.listSessions),
    createSession: advertised.has(OPERATION_METHODS.createSession)
  };
}
async function executeGatewayOperation(client, advertisedMethods, operationName, payload) {
  const operation = browserOperation(operationName);
  if (!operation) return operationError("UNSUPPORTED_OPERATION", "Unsupported operation");
  const method = OPERATION_METHODS[operation];
  const advertised = advertisedMethods instanceof Set ? advertisedMethods : new Set(advertisedMethods);
  if (!advertised.has(method)) return operationError("FEATURE_UNAVAILABLE", "Operation unavailable");
  const validatedPayload = validatePayload(operation, payload);
  if (!validatedPayload) return operationError("INVALID_PAYLOAD", "Invalid operation payload");
  try {
    const data = await client.request(method, validatedPayload);
    return { ok: true, data: projectGatewayData(operation, data) };
  } catch {
    return operationError("GATEWAY_REQUEST_FAILED", "Gateway request failed");
  }
}
function colorOperationError(code, message) {
  return { ok: false, error: { code, message } };
}
function isColorOperation(value) {
  return value === "colors.list" || value === "colors.set";
}
async function executeColorOperation(colors, operation, payload) {
  if (!isRecord$1(payload)) return colorOperationError("INVALID_PAYLOAD", "Invalid operation payload");
  if (operation === "colors.list") {
    if (!hasExactlyKeys$1(payload, [])) return colorOperationError("INVALID_PAYLOAD", "Invalid operation payload");
    try {
      return { ok: true, data: { colors: await colors.list() } };
    } catch {
      return colorOperationError("COLOR_STORE_UNAVAILABLE", "Color state unavailable");
    }
  }
  const color = normalizeAgentColor(payload.color);
  if (!hasExactlyKeys$1(payload, ["agentId", "color"]) || !isAgentId(payload.agentId) || !color) {
    return colorOperationError("INVALID_PAYLOAD", "Invalid operation payload");
  }
  const result = await colors.set(payload.agentId, color);
  return result.ok ? { ok: true, data: { agentId: payload.agentId, color: result.color } } : colorOperationError("COLOR_STORE_UNAVAILABLE", "Color state unavailable");
}
function createPanelRequestBroker(sessions, colors) {
  return {
    async handle(request, sourceIp) {
      if (request.action === "connect") return await sessions.connect(request.token, sourceIp);
      if (request.action === "disconnect") return await sessions.disconnect(request.connectionId);
      const session = sessions.getOperationSession(request.connectionId);
      if (!session) return operationError("CONNECTION_EXPIRED", "Connection expired");
      if (colors && isColorOperation(request.operation)) {
        return await executeColorOperation(colors, request.operation, request.payload);
      }
      return await executeGatewayOperation(
        session.client,
        session.advertisedMethods,
        request.operation,
        request.payload
      );
    }
  };
}
const MAX_PANEL_REQUEST_BYTES = 64 * 1024;
const CONNECTION_ID_PATTERN = /^[0-9a-f]{64}$/;
class ProtocolError extends Error {
  constructor() {
    super("Invalid panel request");
    this.code = "INVALID_REQUEST";
    this.name = "ProtocolError";
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactlyKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index2) => key === expected[index2]);
}
function isConnectionId(value) {
  return typeof value === "string" && CONNECTION_ID_PATTERN.test(value);
}
function parsePanelRequest(raw) {
  if (Buffer$1.byteLength(raw, "utf8") > MAX_PANEL_REQUEST_BYTES) {
    throw new ProtocolError();
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError();
  }
  if (!isRecord(value) || typeof value.action !== "string") {
    throw new ProtocolError();
  }
  if (value.action === "connect") {
    if (!hasExactlyKeys(value, ["action", "token"]) || typeof value.token !== "string" || value.token.length === 0) {
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
    if (!hasExactlyKeys(value, ["action", "connectionId", "operation", "payload"]) || !isConnectionId(value.connectionId) || typeof value.operation !== "string" || value.operation.length === 0 || value.operation.length > 128 || !isRecord(value.payload)) {
      throw new ProtocolError();
    }
    return {
      action: "operation",
      connectionId: value.connectionId,
      operation: value.operation,
      payload: value.payload
    };
  }
  throw new ProtocolError();
}
const PANEL_PREFIX = "/plugins/agent-studio/";
const PANEL_API_PATH = "/plugins/agent-studio/api";
const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts"
].join("; ");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
};
function defaultAssetsRoot() {
  const url = new URL("./ui/", import.meta.url);
  return url.protocol === "file:" ? fileURLToPath(url) : resolve(process.cwd(), "src/ui");
}
function pathnameOf(rawUrl) {
  const raw = rawUrl ?? "";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}
function setNoStore(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}
function endText(res, status, message) {
  res.statusCode = status;
  setNoStore(res);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
  return true;
}
function endApiJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  setNoStore(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
  return true;
}
function endMethodNotAllowed(res) {
  res.setHeader("Allow", "GET, POST");
  return endText(res, 405, "Method not allowed");
}
function sourceIpOf(req) {
  const address = req.socket.remoteAddress ?? "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}
function isHashedAsset(name) {
  return /^.+[.-][a-f0-9]{8,}\.[a-z0-9]+$/.test(basename(name));
}
function decodeAssetPath(pathname) {
  if (!pathname.startsWith(PANEL_PREFIX)) return void 0;
  const raw = pathname.slice(PANEL_PREFIX.length) || "index.html";
  if (/%(?:2f|5c)/i.test(raw)) return void 0;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return void 0;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/")) {
    return void 0;
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return void 0;
  }
  return segments.join(sep);
}
async function resolveAsset(root, assetPath) {
  try {
    const canonicalRoot = await realpath(root);
    const canonicalAsset = await realpath(resolve(canonicalRoot, assetPath));
    const fromRoot = relative(canonicalRoot, canonicalAsset);
    if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === "..") return void 0;
    if ((await stat(canonicalAsset)).isFile()) return canonicalAsset;
  } catch {
  }
  return void 0;
}
async function readUtf8Body(req) {
  const contentLength = req.headers["content-length"];
  if (contentLength !== void 0) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, status: 400 };
    if (Number(contentLength) > MAX_PANEL_REQUEST_BYTES) return { ok: false, status: 413 };
  }
  return await new Promise((resolveBody) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = (keepErrorGuard = false) => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("aborted", onAborted);
      if (!keepErrorGuard) req.removeListener("error", onError);
    };
    const settle = (result, keepErrorGuard = false) => {
      if (settled) return;
      settled = true;
      cleanup(keepErrorGuard);
      if (keepErrorGuard) {
        req.once("close", () => req.removeListener("error", onError));
      }
      resolveBody(result);
    };
    const onData = (rawChunk) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      size += chunk.length;
      if (size > MAX_PANEL_REQUEST_BYTES) {
        req.pause();
        settle({ ok: false, status: 413 }, true);
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        settle({
          ok: true,
          body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
        });
      } catch {
        settle({ ok: false, status: 400 });
      }
    };
    const onAborted = () => settle({ ok: false, status: 400 });
    const onError = () => settle({ ok: false, status: 400 });
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
  });
}
async function handleApi(req, res, broker) {
  setNoStore(res);
  if (req.headers.origin !== "null") return endText(res, 403, "Forbidden");
  res.setHeader("Access-Control-Allow-Origin", "null");
  res.setHeader("Vary", "Origin");
  if (req.headers["content-type"]?.trim().toLowerCase() !== "text/plain") {
    return endText(res, 415, "Unsupported media type");
  }
  const raw = await readUtf8Body(req);
  if (!raw.ok) {
    if (raw.status === 413) {
      res.setHeader("Connection", "close");
      res.once("finish", () => {
        if (typeof req.socket?.end === "function") req.socket.end();
        else req.destroy();
      });
    }
    return endText(res, raw.status, raw.status === 413 ? "Payload too large" : "Bad request");
  }
  let request;
  try {
    request = parsePanelRequest(raw.body);
  } catch (error) {
    if (error instanceof ProtocolError) return endText(res, 400, "Bad request");
    return endText(res, 500, "Internal server error");
  }
  try {
    return endApiJson(res, 200, await broker.handle(request, sourceIpOf(req)));
  } catch {
    return endApiJson(res, 500, {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Internal server error" }
    });
  }
}
async function handleStatic(pathname, res, assetsRoot) {
  const assetPath = decodeAssetPath(pathname);
  if (!assetPath) return endText(res, 400, "Bad request");
  const file = await resolveAsset(assetsRoot, assetPath);
  if (!file) return endText(res, 404, "Not found");
  const body = await readFile(file);
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Content-Security-Policy", PANEL_CSP);
  res.setHeader("Access-Control-Allow-Origin", "null");
  res.setHeader("Vary", "Origin");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Cache-Control",
    isHashedAsset(assetPath) ? "public, max-age=31536000, immutable" : "no-store"
  );
  res.end(body);
  return true;
}
function createAgentStudioHttpHandler(options) {
  const assetsRoot = resolve(options.assetsRoot ?? defaultAssetsRoot());
  return async (req, res) => {
    const pathname = pathnameOf(req.url);
    const method = req.method?.toUpperCase() ?? "";
    if (pathname === PANEL_API_PATH) {
      if (method !== "POST") return endMethodNotAllowed(res);
      return await handleApi(req, res, options.broker);
    }
    if (method === "POST") return endText(res, 404, "Not found");
    if (method !== "GET") return endMethodNotAllowed(res);
    if (!pathname.startsWith(PANEL_PREFIX)) return endText(res, 404, "Not found");
    return await handleStatic(pathname, res, assetsRoot);
  };
}
const PANEL_IDLE_TIMEOUT_MS = 15 * 6e4;
const DEFAULT_GLOBAL_CONNECTION_LIMIT = 32;
const DEFAULT_PER_IP_CONNECTION_LIMIT = 4;
const DEFAULT_ATTEMPT_LIMIT = 5;
const DEFAULT_ATTEMPT_WINDOW_MS = 6e4;
const DEFAULT_CONNECT_TIMEOUT_MS = 1e4;
function errorResult(code, message) {
  return { ok: false, error: { code, message } };
}
function assertLoopbackGatewayUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Gateway URL must use loopback WebSocket transport");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "ws:" && url.protocol !== "wss:" || !loopback || url.username || url.password) {
    throw new Error("Gateway URL must use loopback WebSocket transport");
  }
}
class PanelSessionBroker {
  #gatewayUrl;
  #createGatewayClient;
  #log;
  #limits;
  #connectTimeoutMs;
  #sessions = /* @__PURE__ */ new Map();
  #pendingByIp = /* @__PURE__ */ new Map();
  #attemptsByIp = /* @__PURE__ */ new Map();
  #pendingRejects = /* @__PURE__ */ new Map();
  #stoppedClients = /* @__PURE__ */ new WeakSet();
  #pendingTotal = 0;
  #closed = false;
  constructor(options) {
    assertLoopbackGatewayUrl(options.gatewayUrl);
    this.#gatewayUrl = options.gatewayUrl;
    this.#createGatewayClient = options.createGatewayClient ?? ((clientOptions) => new GatewayClient(clientOptions));
    this.#log = (event) => {
      try {
        options.log?.(event);
      } catch {
      }
    };
    this.#limits = {
      globalConnections: options.limits?.globalConnections ?? DEFAULT_GLOBAL_CONNECTION_LIMIT,
      perIpConnections: options.limits?.perIpConnections ?? DEFAULT_PER_IP_CONNECTION_LIMIT,
      attemptsPerWindow: options.limits?.attemptsPerWindow ?? DEFAULT_ATTEMPT_LIMIT,
      attemptWindowMs: options.limits?.attemptWindowMs ?? DEFAULT_ATTEMPT_WINDOW_MS
    };
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }
  async connect(token, sourceIp) {
    if (this.#closed || !this.#recordAttempt(sourceIp)) {
      this.#log({ action: "connect" });
      return errorResult("RATE_LIMITED", "Too many connection attempts");
    }
    if (!this.#hasCapacity(sourceIp)) {
      this.#log({ action: "connect" });
      return errorResult("CONNECTION_LIMIT", "Connection limit reached");
    }
    this.#reserve(sourceIp);
    let credential = token;
    let resolveHello;
    let rejectHello;
    let connectionId;
    let advertisedMethods = /* @__PURE__ */ new Set();
    let closedBeforeRegistration = false;
    const hello = new Promise((resolve2, reject) => {
      resolveHello = resolve2;
      rejectHello = reject;
    });
    const clientOptions = {
      url: this.#gatewayUrl,
      token: credential,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      clientName: "gateway-client",
      mode: "backend",
      deviceIdentity: null,
      hostDeps: {
        logDebug: () => void 0,
        logError: () => void 0,
        redactForLog: () => "[redacted]"
      },
      onHelloOk: (hello2) => {
        advertisedMethods = new Set(hello2.features.methods);
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
      }
    };
    let client;
    let connectTimer;
    try {
      client = this.#createGatewayClient(clientOptions);
      this.#pendingRejects.set(client, rejectHello);
      connectTimer = setTimeout(
        () => rejectHello(new Error("Gateway authentication timed out")),
        this.#connectTimeoutMs
      );
      client.start();
      await hello;
      token = "";
      credential = void 0;
      clientOptions.token = void 0;
      if (closedBeforeRegistration || this.#closed) throw new Error("Gateway connection closed");
      connectionId = this.#newConnectionId();
      const session = {
        client,
        advertisedMethods,
        sourceIp
      };
      this.#sessions.set(connectionId, session);
      this.#scheduleIdleExpiry(connectionId, session);
      this.#log({ action: "connect", connectionId });
      return {
        ok: true,
        connectionId,
        features: deriveGatewayOperationFeatures([...advertisedMethods])
      };
    } catch {
      if (client) await this.#stopClient(client);
      this.#log({ action: "connect" });
      return errorResult("AUTHENTICATION_FAILED", "Authentication failed");
    } finally {
      credential = void 0;
      clientOptions.token = void 0;
      if (connectTimer) clearTimeout(connectTimer);
      if (client) this.#pendingRejects.delete(client);
      this.#release(sourceIp);
    }
  }
  getClient(connectionId) {
    return this.getOperationSession(connectionId)?.client;
  }
  getOperationSession(connectionId) {
    const session = this.#sessions.get(connectionId);
    if (!session) return void 0;
    this.#scheduleIdleExpiry(connectionId, session);
    return { client: session.client, advertisedMethods: session.advertisedMethods };
  }
  async disconnect(connectionId) {
    const session = this.#sessions.get(connectionId);
    if (!session) return errorResult("CONNECTION_EXPIRED", "Connection expired");
    this.#sessions.delete(connectionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.#log({ action: "disconnect", connectionId });
    await this.#stopClient(session.client);
    return { ok: true };
  }
  snapshot() {
    return { activeConnections: this.#sessions.size };
  }
  async shutdown() {
    if (this.#closed && this.#sessions.size === 0 && this.#pendingRejects.size === 0) return;
    this.#closed = true;
    const clients = /* @__PURE__ */ new Set();
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
  #recordAttempt(sourceIp) {
    const now = Date.now();
    for (const [ip, attempts2] of this.#attemptsByIp) {
      const recent = attempts2.filter((time) => now - time < this.#limits.attemptWindowMs);
      if (recent.length === 0) this.#attemptsByIp.delete(ip);
      else if (recent.length !== attempts2.length) this.#attemptsByIp.set(ip, recent);
    }
    const attempts = this.#attemptsByIp.get(sourceIp) ?? [];
    if (attempts.length >= this.#limits.attemptsPerWindow) return false;
    attempts.push(now);
    this.#attemptsByIp.set(sourceIp, attempts);
    if (this.#attemptsByIp.size > 1024) {
      const oldest = this.#attemptsByIp.keys().next().value;
      if (oldest && oldest !== sourceIp) this.#attemptsByIp.delete(oldest);
    }
    return true;
  }
  #hasCapacity(sourceIp) {
    if (this.#sessions.size + this.#pendingTotal >= this.#limits.globalConnections) return false;
    let activeForIp = 0;
    for (const session of this.#sessions.values()) {
      if (session.sourceIp === sourceIp) activeForIp += 1;
    }
    return activeForIp + (this.#pendingByIp.get(sourceIp) ?? 0) < this.#limits.perIpConnections;
  }
  #reserve(sourceIp) {
    this.#pendingTotal += 1;
    this.#pendingByIp.set(sourceIp, (this.#pendingByIp.get(sourceIp) ?? 0) + 1);
  }
  #release(sourceIp) {
    this.#pendingTotal -= 1;
    const next = (this.#pendingByIp.get(sourceIp) ?? 1) - 1;
    if (next === 0) this.#pendingByIp.delete(sourceIp);
    else this.#pendingByIp.set(sourceIp, next);
  }
  #newConnectionId() {
    let id;
    do
      id = randomBytes(32).toString("hex");
    while (this.#sessions.has(id));
    return id;
  }
  #scheduleIdleExpiry(connectionId, session) {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(async () => {
      if (this.#sessions.get(connectionId) !== session) return;
      this.#sessions.delete(connectionId);
      await this.#stopClient(session.client);
    }, PANEL_IDLE_TIMEOUT_MS);
  }
  #dropClosedSession(connectionId) {
    const session = this.#sessions.get(connectionId);
    if (!session) return;
    this.#sessions.delete(connectionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    void this.#stopClient(session.client);
  }
  async #stopClient(client) {
    if (this.#stoppedClients.has(client)) return;
    this.#stoppedClients.add(client);
    await client.stopAndWait().catch(() => void 0);
  }
}
function createAgentStudioColorStore(api) {
  return new AgentColorStore(api.runtime.state.resolveStateDir(process.env));
}
async function shutdownAgentStudioResources(sessions, colors) {
  await Promise.allSettled(
    [sessions, colors].filter((resource) => resource !== void 0).map(async (resource) => await resource.shutdown())
  );
}
function loopbackGatewayUrl(config) {
  if (typeof config !== "object" || config === null || !("gateway" in config)) {
    return "ws://127.0.0.1:18789";
  }
  const gateway = config.gateway;
  if (typeof gateway !== "object" || gateway === null || !("port" in gateway)) {
    return "ws://127.0.0.1:18789";
  }
  const port = gateway.port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? `ws://127.0.0.1:${port}` : "ws://127.0.0.1:18789";
}
const index = definePluginEntry({
  id: "agent-studio",
  name: "Agent Studio",
  description: "Operator workspace for Agent Studio.",
  register(api) {
    let sessions;
    let colors;
    const getSessions = () => {
      sessions ??= new PanelSessionBroker({ gatewayUrl: loopbackGatewayUrl(api.config) });
      return sessions;
    };
    const getColors = () => {
      colors ??= createAgentStudioColorStore(api);
      return colors;
    };
    const broker = createPanelRequestBroker({
      connect: async (token, sourceIp) => await getSessions().connect(token, sourceIp),
      disconnect: async (connectionId) => await getSessions().disconnect(connectionId),
      getOperationSession: (connectionId) => getSessions().getOperationSession(connectionId)
    }, {
      list: async () => await getColors().list(),
      set: async (agentId, color) => await getColors().set(agentId, color)
    });
    api.session.controls.registerControlUiDescriptor({
      id: "agent-studio",
      surface: "tab",
      label: "Agent Studio",
      group: "agent",
      requiredScopes: ["operator.write"],
      path: "/plugins/agent-studio/"
    });
    api.registerHttpRoute({
      path: "/plugins/agent-studio/",
      auth: "plugin",
      match: "prefix",
      handler: createAgentStudioHttpHandler({ broker })
    });
    api.lifecycle?.registerRuntimeLifecycle({
      id: "agent-studio-panel-sessions",
      description: "Drain Agent Studio state and close Gateway clients during runtime cleanup.",
      cleanup: async () => await shutdownAgentStudioResources(sessions, colors)
    });
  }
});
export {
  createAgentStudioColorStore,
  index as default,
  shutdownAgentStudioResources
};
