// Exact Fetch routes for the browser panel.
//
// These are registered through ctx.connection.registerFetchRoute, i.e. on the
// harness's own /api channel, so the four Host/Origin checks and browser-session
// authentication run BEFORE any handler below. Registering an own
// /api/dsh-mcp-manager PREFIX route on ctx.webServer would be a longer prefix,
// would therefore win the match, and would bypass both. Do not do that.
import fs from 'node:fs';
import { loadPatchStructured } from './dump.js';
import { defaultPatchPath } from './patchfile.js';
import { isMcpClientRow, maskEntry } from './rows.js';

export const ROUTE_PREFIX = '/api/dsh-mcp-manager';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fail(code, message, status) {
  return json({ error: { code, message } }, status);
}

async function readEntries(patchPath) {
  if (!fs.existsSync(patchPath)) throw new Error(`patch file not found: ${patchPath}`);
  const { entries } = await loadPatchStructured(patchPath);
  return entries ?? [];
}

async function loadOrFail(patchPath) {
  try {
    return { entries: await readEntries(patchPath) };
  } catch (e) {
    return { response: fail('internal', String(e.message || e), 500) };
  }
}

/**
 * Live-connection snapshot from the scoped MCP resource registry.
 * `merge(undefined, ...)` is the documented "global view" and always starts
 * from the global layer, where profile-level MCP rows register.
 */
function liveServers(ctx) {
  const service = ctx.get('mcpResources');
  if (!service?.layers?.merge) return { available: false, names: new Set() };
  try {
    const merged = service.layers.merge(undefined, (layer) => layer.servers);
    return { available: true, names: new Set(merged.keys()) };
  } catch {
    return { available: false, names: new Set() };
  }
}

async function handleServers(ctx, patchPath) {
  const loaded = await loadOrFail(patchPath);
  if (loaded.response) return loaded.response;
  const { available, names } = liveServers(ctx);
  const servers = loaded.entries.filter(isMcpClientRow).map(maskEntry).map((e) => {
    const c = e.config ?? {};
    return {
      id: e.id,
      serverName: c.serverName ?? '',
      transport: c.transport ?? '',
      command: c.command ?? '',
      args: Array.isArray(c.args) ? c.args : [],
      url: c.url ?? '',
      disabled: e.disabled === true,
      live: available && names.has(c.serverName),
    };
  });
  return json({ patch: patchPath, resourcesAvailable: available, servers });
}

export function createRoutes(ctx, { patchPath = defaultPatchPath() } = {}) {
  return [
    { path: `${ROUTE_PREFIX}/servers`, methods: ['GET'], requestBody: 'buffered',
      fetch: () => handleServers(ctx, patchPath) },
  ];
}

/** Register every route on the harness's own /api channel. */
export function registerRoutes(ctx, connection, options = {}) {
  return createRoutes(ctx, options).map((route) => connection.registerFetchRoute(ctx, route));
}
