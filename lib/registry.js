// The only module that talks to the official MCP Registry.
//
// Everything it returns is UNTRUSTED external input: lib/market.js treats every
// field defensively. This module's own job is narrower — never let a remote
// failure escape as an exception (a dead registry must not break the panel's
// installed-server view), and never let a hostile response exhaust the process.

const DEFAULT_BASE = 'https://registry.modelcontextprotocol.io';
// Measured against the live registry (2026-10-13): /v0/ping answers in ~1s, but
// /v0/servers?search=… ranged from 1.2s to 30s across four calls, and returned
// HTTP 500 once. A tighter budget does not make the endpoint faster — it only
// turns a slow success into a false "registry unreachable". Callers that must
// stay interactive pass their own `timeoutMs`.
const TIMEOUT_MS = 30000;
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RETRY_BACKOFF_MS = 300;

const cache = new Map(); // key -> { at, value }

export function clearRegistryCache() { cache.clear(); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function keyOf(baseUrl, path, params) {
  return `${baseUrl}${path}?${new URLSearchParams(params).toString()}`;
}

/**
 * One GET, with a timeout, a size cap and at most one retry.
 * Never throws for a remote failure: returns { ok: false, reason }.
 * A caller-initiated abort IS rethrown — that is the caller's own signal.
 */
async function getJson(url, { fetchFn, signal, timeoutMs = TIMEOUT_MS }) {
  let lastReason = 'registry unreachable';
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    let timedOut = false;
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    try {
      const res = await fetchFn(url, { signal: ac.signal, headers: { accept: 'application/json' } });
      if (!res.ok) {
        lastReason = `HTTP ${res.status}`;
        if (res.status >= 500 && attempt === 0) { await sleep(RETRY_BACKOFF_MS); continue; }
        return { ok: false, reason: lastReason };
      }
      const declared = Number(res.headers?.get?.('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > MAX_BYTES) {
        return { ok: false, reason: 'registry response too large' };
      }
      const text = await res.text();
      if (text.length > MAX_BYTES) return { ok: false, reason: 'registry response too large' };
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      if (signal?.aborted) throw e;
      if (timedOut) return { ok: false, reason: `registry timeout after ${timeoutMs}ms` };
      lastReason = String(e?.message || e);
      if (attempt === 0) { await sleep(RETRY_BACKOFF_MS); continue; }
      return { ok: false, reason: lastReason };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * GET /v0/servers — `search` matches the NAME only (substring); it is not a
 * description search. lib/market.js re-ranks the returned page locally to soften
 * that, and the panel says "by name" out loud rather than pretending.
 */
export async function searchServers({
  query, limit = 30, cursor, baseUrl = DEFAULT_BASE,
  fetchFn = globalThis.fetch, signal, now = Date.now, timeoutMs = TIMEOUT_MS,
} = {}) {
  const params = { limit: String(limit), version: 'latest' };
  if (query) params.search = String(query);
  if (cursor) params.cursor = String(cursor);
  const key = keyOf(baseUrl, '/v0/servers', params);

  const hit = cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.value, fetchedAt: hit.at, fromCache: true };
  }
  const r = await getJson(`${baseUrl}/v0/servers?${new URLSearchParams(params)}`, { fetchFn, signal, timeoutMs });
  if (!r.ok) return { servers: [], fetchedAt: now(), fromCache: false, degraded: r.reason };

  const value = {
    servers: Array.isArray(r.value?.servers) ? r.value.servers : [],
    nextCursor: r.value?.metadata?.nextCursor,
  };
  cache.set(key, { at: now(), value });
  return { ...value, fetchedAt: now(), fromCache: false };
}

/**
 * GET /v0/servers/{name}/versions/{version} — `version` may be `latest`.
 * Returns an object rather than a bare server so "not found" and "registry
 * down" stay distinguishable.
 */
export async function getServer({
  name, version = 'latest', baseUrl = DEFAULT_BASE,
  fetchFn = globalThis.fetch, signal, now = Date.now, timeoutMs = TIMEOUT_MS,
} = {}) {
  const path = `/v0/servers/${encodeURIComponent(String(name))}/versions/${encodeURIComponent(String(version))}`;
  const hit = cache.get(baseUrl + path);
  if (hit && now() - hit.at < CACHE_TTL_MS) return { server: hit.value, fromCache: true };

  const r = await getJson(baseUrl + path, { fetchFn, signal, timeoutMs });
  if (!r.ok) return { server: undefined, error: r.reason, fromCache: false };
  const server = r.value?.server;
  if (!server) return { server: undefined, error: `registry entry not found: ${name}`, fromCache: false };
  cache.set(baseUrl + path, { at: now(), value: server });
  return { server, fromCache: false };
}
