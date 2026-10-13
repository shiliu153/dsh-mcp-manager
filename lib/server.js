// Exact Fetch routes for the browser panel.
//
// These are registered through ctx.connection.registerFetchRoute, i.e. on the
// harness's own /api channel, so the four Host/Origin checks and browser-session
// authentication run BEFORE any handler below. Registering an own
// /api/dsh-mcp-manager PREFIX route on ctx.webServer would be a longer prefix,
// would therefore win the match, and would bypass both. Do not do that.
import fs from 'node:fs';
import { loadPatchStructured } from './dump.js';
import { applySurgeryAsync, defaultPatchPath, renderEntryRow } from './patchfile.js';
import { probeConfig } from './probe.js';
import { resolveInput } from './resolve.js';
import { isMcpClientRow, maskEntry } from './rows.js';

export const ROUTE_PREFIX = '/api/dsh-mcp-manager';

const PROBE_TIMEOUT_DEFAULT_S = 60;
const PROBE_TIMEOUT_MIN_S = 5;
const PROBE_TIMEOUT_MAX_S = 180;

/** Clamp a probe timeout: first npx pull is 30-60s, but never wait forever. */
export function clampProbeTimeoutMs(seconds) {
  const n = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : PROBE_TIMEOUT_DEFAULT_S;
  return Math.round(Math.min(PROBE_TIMEOUT_MAX_S, Math.max(PROBE_TIMEOUT_MIN_S, n)) * 1000);
}

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

async function readJson(req) {
  let text;
  try {
    text = await req.text();
  } catch (e) {
    return { response: fail('bad_request', `unreadable body: ${e.message}`, 400) };
  }
  if (!text.trim()) return { body: {} };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { response: fail('bad_request', 'body must be JSON', 400) };
  }
}

async function handleToggle(req, patchPath) {
  const parsed = await readJson(req);
  if (parsed.response) return parsed.response;
  const { id, disabled } = parsed.body ?? {};
  if (typeof id !== 'string' || !id) return fail('bad_request', 'id is required', 400);
  if (typeof disabled !== 'boolean') return fail('bad_request', 'disabled must be a boolean', 400);
  const loaded = await loadOrFail(patchPath);
  if (loaded.response) return loaded.response;
  if (!loaded.entries.some((e) => e.id === id)) return fail('not_found', `entry not found: ${id}`, 404);
  try {
    const r = await applySurgeryAsync({ file: patchPath, operation: { type: 'setDisabled', id, value: disabled } });
    return json({ id, disabled, backup: r.backupPath });
  } catch (e) {
    return fail('internal', String(e.message || e), 500);
  }
}

async function handleRemove(req, patchPath) {
  const parsed = await readJson(req);
  if (parsed.response) return parsed.response;
  const { id } = parsed.body ?? {};
  if (typeof id !== 'string' || !id) return fail('bad_request', 'id is required', 400);
  const loaded = await loadOrFail(patchPath);
  if (loaded.response) return loaded.response;
  if (!loaded.entries.some((e) => e.id === id)) return fail('not_found', `entry not found: ${id}`, 404);
  try {
    const r = await applySurgeryAsync({ file: patchPath, operation: { type: 'remove', id } });
    return json({ id, backup: r.backupPath });
  } catch (e) {
    return fail('internal', String(e.message || e), 500);
  }
}

async function handleProbe(req, patchPath, probe) {
  const parsed = await readJson(req);
  if (parsed.response) return parsed.response;
  const { id, timeout_s } = parsed.body ?? {};
  if (typeof id !== 'string' || !id) return fail('bad_request', 'id is required', 400);
  const loaded = await loadOrFail(patchPath);
  if (loaded.response) return loaded.response;
  const entry = loaded.entries.find((e) => e.id === id);
  if (!entry) return fail('not_found', `entry not found: ${id}`, 404);
  const r = await probe(entry.config ?? {}, { timeoutMs: clampProbeTimeoutMs(timeout_s) });
  return json(r.ok
    ? { id, toolCount: r.toolCount ?? 0, tools: r.tools ?? [] }
    : { id, toolCount: 0, tools: [], error: r.error ?? 'probe failed' });
}

function previewOf(row) {
  return [`- id: ${row.id}`, `  name: '${row.name}'`, ...row.configLines].join('\n');
}

async function handleAdd(req, patchPath, probe) {
  const parsed = await readJson(req);
  if (parsed.response) return parsed.response;
  const { input, confirm } = parsed.body ?? {};
  if (typeof input !== 'string' || !input.trim()) return fail('bad_request', 'input is required', 400);

  let resolved;
  try {
    resolved = await resolveInput(input);
  } catch (e) {
    return fail('bad_request', String(e.message || e), 400);
  }
  const notes = resolved.notes ?? [];
  const warnings = resolved.warnings ?? [];
  if (resolved.needsInput?.length) {
    return json({ preview: null, notes, warnings, needsInput: resolved.needsInput });
  }

  const row = renderEntryRow(resolved.entry);
  const preview = previewOf(row);
  if (confirm !== true) return json({ preview, notes, warnings, needsInput: [] });

  try {
    const r = await applySurgeryAsync({ file: patchPath, operation: { type: 'appendEntry', row } });
    const pr = await probe(resolved.entry.config ?? {}, { timeoutMs: clampProbeTimeoutMs(60) });
    return json({
      written: true,
      backup: r.backupPath,
      preview,
      notes,
      warnings,
      probe: pr.ok ? { ok: true, toolCount: pr.toolCount ?? 0 } : { ok: false, error: pr.error ?? 'probe failed' },
    });
  } catch (e) {
    return fail('internal', String(e.message || e), 500);
  }
}

export function createRoutes(ctx, { patchPath = defaultPatchPath(), probe = probeConfig } = {}) {
  return [
    { path: `${ROUTE_PREFIX}/servers`, methods: ['GET'], requestBody: 'buffered',
      fetch: () => handleServers(ctx, patchPath) },
    { path: `${ROUTE_PREFIX}/probe`, methods: ['POST'], requestBody: 'buffered',
      fetch: (req) => handleProbe(req, patchPath, probe) },
    { path: `${ROUTE_PREFIX}/toggle`, methods: ['POST'], requestBody: 'buffered',
      fetch: (req) => handleToggle(req, patchPath) },
    { path: `${ROUTE_PREFIX}/remove`, methods: ['POST'], requestBody: 'buffered',
      fetch: (req) => handleRemove(req, patchPath) },
    { path: `${ROUTE_PREFIX}/add`, methods: ['POST'], requestBody: 'buffered',
      fetch: (req) => handleAdd(req, patchPath, probe) },
  ];
}

/** Register every route on the harness's own /api channel. */
export function registerRoutes(ctx, connection, options = {}) {
  return createRoutes(ctx, options).map((route) => connection.registerFetchRoute(ctx, route));
}
