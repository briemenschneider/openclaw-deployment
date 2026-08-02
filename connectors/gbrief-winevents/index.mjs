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

const BASE_URL = process.env.WINEVENTS_URL ?? 'http://host.docker.internal:18791';
const TOKEN = process.env.WINEVENTS_TOKEN ?? '';
const TIMEOUT_MS = 10_000;

export function clampHours(h) {
  if (h === undefined || h === null) return 24;
  const n = Number(h);
  if (!Number.isFinite(n)) return 24;
  return Math.min(168, Math.max(1, Math.trunc(n)));
}

export async function fetchDigest(baseUrl, token, hours, fetchImpl = fetch) {
  const url = `${baseUrl}/events?hours=${clampHours(hours)}`;
  try {
    const res = await fetchImpl(url, {
      headers: { 'X-Brief-Token': token },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, error: `collector returned HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: `collector unreachable: ${err.message}` };
  }
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
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  await server.connect(new StdioServerTransport());
}
