import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchServers, getServer, clearRegistryCache } from '../lib/registry.js';

/** A fetch stand-in that records calls and answers from a script. */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

const ONE = { server: { name: 'ai.x/one', version: '1.0.0' }, _meta: {} };

test('searchServers returns servers and the next cursor', async () => {
  const fetchFn = fakeFetch(() => jsonResponse({ servers: [ONE], metadata: { count: 1, nextCursor: 'c2' } }));
  const r = await searchServers({ query: 'one', fetchFn });
  assert.equal(r.servers.length, 1);
  assert.equal(r.nextCursor, 'c2');
  assert.equal(r.fromCache, false);
  assert.equal(r.degraded, undefined);
  assert.match(fetchFn.calls[0].url, /\/v0\/servers\?/);
  assert.match(fetchFn.calls[0].url, /search=one/);
  assert.match(fetchFn.calls[0].url, /version=latest/);
});

test('a second identical search is served from cache', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch(() => jsonResponse({ servers: [ONE], metadata: { count: 1 } }));
  await searchServers({ query: 'one', fetchFn });
  const r = await searchServers({ query: 'one', fetchFn });
  assert.equal(r.fromCache, true);
  assert.equal(fetchFn.calls.length, 1, 'the network is hit once');
});

test('the cache expires after its TTL', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch(() => jsonResponse({ servers: [ONE], metadata: { count: 1 } }));
  let clock = 1_000_000;
  await searchServers({ query: 'one', fetchFn, now: () => clock });
  clock += 5 * 60 * 1000 + 1;
  const r = await searchServers({ query: 'one', fetchFn, now: () => clock });
  assert.equal(r.fromCache, false);
  assert.equal(fetchFn.calls.length, 2);
});

test('a 5xx is retried once, then reported as degraded instead of thrown', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch(() => jsonResponse({}, { status: 503 }));
  const r = await searchServers({ query: 'x', fetchFn });
  assert.equal(fetchFn.calls.length, 2, 'one retry');
  assert.equal(r.degraded, 'HTTP 503');
  assert.deepEqual(r.servers, []);
});

test('a 404 is not retried', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch(() => jsonResponse({}, { status: 404 }));
  const r = await searchServers({ query: 'x', fetchFn });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(r.degraded, 'HTTP 404');
});

test('a network error is retried once, then degraded', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch(() => { throw new Error('getaddrinfo ENOTFOUND'); });
  const r = await searchServers({ query: 'x', fetchFn });
  assert.equal(fetchFn.calls.length, 2);
  assert.match(r.degraded, /ENOTFOUND/);
});

test('an oversized body is refused by the content-length pre-check', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch(() => jsonResponse({ servers: [] }, { headers: { 'content-length': String(3 * 1024 * 1024) } }));
  const r = await searchServers({ query: 'x', fetchFn });
  assert.equal(r.degraded, 'registry response too large');
  assert.equal(fetchFn.calls.length, 1, 'no retry for a body that is too big');
});

test('an oversized body is refused even without content-length', async () => {
  clearRegistryCache();
  const huge = { servers: [], padding: 'x'.repeat(3 * 1024 * 1024) };
  const fetchFn = fakeFetch(() => jsonResponse(huge));
  const r = await searchServers({ query: 'x', fetchFn });
  assert.equal(r.degraded, 'registry response too large');
});

test('getServer decodes the name and asks for one version', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch(() => jsonResponse({ server: { name: 'ai.x/one', version: '1.0.0' }, _meta: {} }));
  const r = await getServer({ name: 'ai.x/one', fetchFn });
  assert.equal(r.server.name, 'ai.x/one');
  assert.match(fetchFn.calls[0].url, /\/v0\/servers\/ai\.x%2Fone\/versions\/latest$/);
});

test('getServer reports a missing entry instead of returning undefined silently', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch(() => jsonResponse({}, { status: 404 }));
  const r = await getServer({ name: 'ai.x/nope', fetchFn });
  assert.equal(r.server, undefined);
  assert.match(r.error, /HTTP 404/);
});

test('a caller abort propagates instead of being swallowed as degraded', async () => {
  clearRegistryCache();
  const ac = new AbortController();
  const fetchFn = fakeFetch(() => { ac.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  await assert.rejects(() => searchServers({ query: 'x', fetchFn, signal: ac.signal }), /abort/i);
});

test('a timeout is reported as degraded and is not retried', async () => {
  clearRegistryCache();
  // Reject only when the request's own signal fires, i.e. when getJson's timer
  // aborts it. A 20ms budget keeps this honest without waiting the real 8s.
  const fetchFn = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  }));
  const r = await searchServers({ query: 'x', fetchFn, timeoutMs: 20 });
  assert.equal(r.degraded, 'registry timeout after 20ms');
  assert.equal(fetchFn.calls.length, 1, 'a timeout is not retried');
  assert.deepEqual(r.servers, []);
});

test('getServer surfaces a timeout the same way', async () => {
  clearRegistryCache();
  const fetchFn = fakeFetch((url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      reject(e);
    });
  }));
  const r = await getServer({ name: 'ai.x/one', fetchFn, timeoutMs: 20 });
  assert.equal(r.server, undefined);
  assert.match(r.error, /timeout after 20ms/);
});
