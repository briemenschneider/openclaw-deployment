#!/usr/bin/env node
/**
 * MCP stdio server exposing the Windows event collector as a single tool.
 *
 * Transport only - all filtering lives in WinEventsCore.psm1 on the Windows
 * side, where it is unit-testable against synthetic events.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';

const BASE_URL = process.env.WINEVENTS_URL ?? 'http://host.docker.internal:18791';
const TOKEN = process.env.WINEVENTS_TOKEN ?? '';
const TIMEOUT_MS = 10_000;

export function clampHours(h) {
  if (h === undefined || h === null) return 24;
  const n = Number(h);
  if (!Number.isFinite(n)) return 24;
  return Math.min(168, Math.max(1, Math.trunc(n)));
}

function payloadTypeOf(body) {
  if (body === null) return 'null';
  if (Array.isArray(body)) return 'array';
  return typeof body;
}

export async function fetchDigest(baseUrl, token, hours, fetchImpl = fetch) {
  const url = `${baseUrl}/events?hours=${clampHours(hours)}`;

  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'X-Brief-Token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { ok: false, error: `collector timed out after ${TIMEOUT_MS / 1000}s` };
    }
    // A thrown value is not guaranteed to be an Error - `throw 'boom'` is legal
    // and some transports reject with strings or plain objects. Reading
    // .message off a bare string yields undefined (harmless), but off null or
    // undefined it THROWS, which would escape this catch, break the shim's
    // never-throw contract, and turn a structured error the brief can report
    // into an opaque MCP protocol error. Coerce instead.
    return { ok: false, error: `collector unreachable: ${String(err?.message ?? err)}` };
  }

  if (!res.ok) {
    return { ok: false, error: `collector returned HTTP ${res.status}` };
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, error: `collector returned a malformed response: ${err.message}` };
  }

  const type = payloadTypeOf(body);
  if (type !== 'object') {
    return { ok: false, error: `collector returned an unexpected payload type: ${type}` };
  }

  return body;
}

const server = new Server(
  { name: 'gbrief-winevents', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'windows_events_digest',
      description:
        'Filtered Windows event log digest for this machine: Critical/Error system and application events, firewall rule changes, service installs, and failed logons. Already deduplicated and noise-filtered. Returns channelsUnavailable when a log could not be read.',
      inputSchema: {
        type: 'object',
        properties: {
          hours: {
            type: 'integer',
            description: 'Lookback window in hours (1-168). Defaults to 24.',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'windows_events_digest') {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  const digest = await fetchDigest(BASE_URL, TOKEN, req.params.arguments?.hours);
  return { content: [{ type: 'text', text: JSON.stringify(digest, null, 2) }] };
});

// Only connect stdio when run as the entrypoint, so tests can import cleanly.
//
// This is an exact module-identity check, not a filename suffix match. The
// suffix form (`process.argv[1].endsWith('index.mjs')`) fails open in the
// wrong direction: if it ever stops matching - a symlinked or renamed
// entrypoint, a bundler, a launcher that passes a different argv[1] - the
// process starts, registers no transport, has nothing to wait on, and exits 0.
// A silent start failure reported as success is the exact failure mode this
// whole branch exists to eliminate. Comparing import.meta.url against the
// resolved argv[1] URL is true when and only when this module IS the
// entrypoint.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await server.connect(new StdioServerTransport());
}
