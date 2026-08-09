import { realpath, readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_PANEL_REQUEST_BYTES,
  parsePanelRequest,
  ProtocolError,
  type PanelRequest,
} from "./protocol.js";

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
  "sandbox allow-scripts",
].join("; ");

const MIME_TYPES: Readonly<Record<string, string>> = {
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
  ".woff2": "font/woff2",
};

export type PanelRequestBroker = {
  handle(request: PanelRequest, sourceIp: string): Promise<unknown>;
};

export type AgentStudioHttpHandlerOptions = {
  assetsRoot?: string;
  broker: PanelRequestBroker;
};

function defaultAssetsRoot(): string {
  const url = new URL("./ui/", import.meta.url);
  return url.protocol === "file:" ? fileURLToPath(url) : resolve(process.cwd(), "src/ui");
}

type ReadBodyResult =
  | { ok: true; body: string }
  | { ok: false; status: 400 | 413 };

function pathnameOf(rawUrl: string | undefined): string {
  const raw = rawUrl ?? "";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}

function setNoStore(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function endText(res: ServerResponse, status: number, message: string): true {
  res.statusCode = status;
  setNoStore(res);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
  return true;
}

function endApiJson(res: ServerResponse, status: number, value: unknown): true {
  const body = JSON.stringify(value);
  res.statusCode = status;
  setNoStore(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
  return true;
}

function endMethodNotAllowed(res: ServerResponse): true {
  res.setHeader("Allow", "GET, POST");
  return endText(res, 405, "Method not allowed");
}

function sourceIpOf(req: IncomingMessage): string {
  const address = req.socket.remoteAddress ?? "unknown";
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

function isHashedAsset(name: string): boolean {
  return /[.-][A-Za-z0-9_-]{8,}(?=\.)/.test(basename(name));
}

function decodeAssetPath(pathname: string): string | undefined {
  if (!pathname.startsWith(PANEL_PREFIX)) return undefined;
  const raw = pathname.slice(PANEL_PREFIX.length) || "index.html";
  if (/%(?:2f|5c)/i.test(raw)) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.startsWith("/")) {
    return undefined;
  }
  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return undefined;
  }
  return segments.join(sep);
}

async function resolveAsset(root: string, assetPath: string): Promise<string | undefined> {
  try {
    const canonicalRoot = await realpath(root);
    const canonicalAsset = await realpath(resolve(canonicalRoot, assetPath));
    const fromRoot = relative(canonicalRoot, canonicalAsset);
    if (fromRoot === "" || fromRoot.startsWith(`..${sep}`) || fromRoot === "..") return undefined;
    if ((await stat(canonicalAsset)).isFile()) return canonicalAsset;
  } catch {
    // Missing and inaccessible files are indistinguishable to callers.
  }
  return undefined;
}

async function readUtf8Body(req: IncomingMessage): Promise<ReadBodyResult> {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength)) return { ok: false, status: 400 };
    if (Number(contentLength) > MAX_PANEL_REQUEST_BYTES) return { ok: false, status: 413 };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let oversized = false;
  try {
    for await (const rawChunk of req) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      size += chunk.length;
      if (size > MAX_PANEL_REQUEST_BYTES) {
        oversized = true;
        continue;
      }
      chunks.push(chunk);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  if (oversized) return { ok: false, status: 413 };

  try {
    return {
      ok: true,
      body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    };
  } catch {
    return { ok: false, status: 400 };
  }
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  broker: PanelRequestBroker,
): Promise<true> {
  setNoStore(res);
  if (req.headers.origin !== "null") return endText(res, 403, "Forbidden");
  res.setHeader("Access-Control-Allow-Origin", "null");
  res.setHeader("Vary", "Origin");
  if (req.headers["content-type"]?.trim().toLowerCase() !== "text/plain") {
    return endText(res, 415, "Unsupported media type");
  }

  const raw = await readUtf8Body(req);
  if (!raw.ok) return endText(res, raw.status, raw.status === 413 ? "Payload too large" : "Bad request");

  let request: PanelRequest;
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
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
  }
}

async function handleStatic(
  pathname: string,
  res: ServerResponse,
  assetsRoot: string,
): Promise<true> {
  const assetPath = decodeAssetPath(pathname);
  if (!assetPath) return endText(res, 400, "Bad request");
  const file = await resolveAsset(assetsRoot, assetPath);
  if (!file) return endText(res, 404, "Not found");

  const body = await readFile(file);
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
  res.setHeader("Content-Length", body.length);
  res.setHeader("Content-Security-Policy", PANEL_CSP);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader(
    "Cache-Control",
    isHashedAsset(assetPath) ? "public, max-age=31536000, immutable" : "no-store",
  );
  res.end(body);
  return true;
}

export function createAgentStudioHttpHandler(options: AgentStudioHttpHandlerOptions) {
  const assetsRoot = resolve(options.assetsRoot ?? defaultAssetsRoot());
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
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
