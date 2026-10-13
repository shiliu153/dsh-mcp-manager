import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRoutes, ROUTE_PREFIX } from '../lib/server.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(dir, 'fixtures/patch-servers.yml');

/** Fake ctx exposing only what the route table reads. */
function fakeCtx({ liveNames } = {}) {
  return {
    get(name) {
      if (name !== 'mcpResources' || liveNames === undefined) return undefined;
      return { layers: { merge: () => new Map(liveNames.map((n) => [n, {}])) } };
    },
  };
}

function routeFor(routes, method, suffix) {
  const target = `${ROUTE_PREFIX}${suffix}`;
  const route = routes.find((r) => r.path === target);
  assert.ok(route, `no route for ${target}`);
  assert.ok(route.methods.includes(method), `${target} does not declare ${method}`);
  return route;
}

const get = (route) => route.fetch(new Request(`http://127.0.0.1${route.path}`, { method: 'GET' }));

test('route table stays under /api and declares no duplicate paths', () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  assert.ok(routes.length > 0);
  const seen = new Set();
  for (const r of routes) {
    assert.ok(r.path.startsWith('/api/'), `${r.path} is not under /api`);
    assert.ok(!seen.has(r.path), `duplicate path ${r.path}`);
    seen.add(r.path);
    assert.equal(new Set(r.methods).size, r.methods.length, `duplicate method on ${r.path}`);
    assert.equal(r.requestBody, 'buffered');
    assert.equal(typeof r.fetch, 'function');
  }
});

test('GET /servers lists MCP rows only, masked, with live flags', async () => {
  const routes = createRoutes(fakeCtx({ liveNames: ['alpha'] }), { patchPath: fixture });
  const res = await get(routeFor(routes, 'GET', '/servers'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.patch, fixture);
  assert.equal(body.resourcesAvailable, true);
  assert.deepEqual(body.servers.map((s) => s.id), ['mcp-alpha', 'mcp-beta', 'mcp-gamma']);
  const alpha = body.servers.find((s) => s.id === 'mcp-alpha');
  assert.deepEqual(alpha, { id: 'mcp-alpha', serverName: 'alpha', transport: 'stdio',
    command: 'npx', args: ['-y', 'alpha-mcp'], url: '', disabled: false, live: true });
  const beta = body.servers.find((s) => s.id === 'mcp-beta');
  assert.equal(beta.live, false);
  const gamma = body.servers.find((s) => s.id === 'mcp-gamma');
  assert.equal(gamma.disabled, true);
  assert.equal(gamma.env, undefined, 'servers[] must not carry env');
});

test('GET /servers never leaks a credential value', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const text = await (await get(routeFor(routes, 'GET', '/servers'))).text();
  assert.ok(!text.includes('gamma-token.txt'), 'raw expression must not reach the browser');
});

test('GET /servers reports resourcesAvailable false when mcpResources is absent', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const body = await (await get(routeFor(routes, 'GET', '/servers'))).json();
  assert.equal(body.resourcesAvailable, false);
  assert.ok(body.servers.every((s) => s.live === false));
});

test('GET /servers answers 500 with a structured error when the patch is unreadable', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: path.join(dir, 'fixtures/does-not-exist.yml') });
  const res = await get(routeFor(routes, 'GET', '/servers'));
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, 'internal');
});
