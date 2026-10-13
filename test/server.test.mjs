import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
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

// ---- write routes: every test runs on a throwaway copy, never the fixture ----

function copyFixture() {
  const dst = path.join(os.tmpdir(), `patch-${process.pid}-${Math.random().toString(36).slice(2)}.yml`);
  fs.copyFileSync(fixture, dst);
  return dst;
}

const post = (route, body) => route.fetch(new Request(`http://127.0.0.1${route.path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}));

test('POST /toggle flips disabled and keeps comments intact', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file });
  const res = await post(routeFor(routes, 'POST', '/toggle'), { id: 'mcp-alpha', disabled: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, 'mcp-alpha');
  assert.equal(body.disabled, true);
  assert.ok(body.backup.endsWith('.bak'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /# keep this comment/, 'comment block must survive the surgery');
  assert.match(text, /- id: mcp-alpha\n(?:.*\n)*?  disabled: true/);
});

test('POST /toggle rejects a bad body and an unknown id', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file });
  const toggle = routeFor(routes, 'POST', '/toggle');
  const noId = await post(toggle, { disabled: true });
  assert.equal(noId.status, 400);
  assert.equal((await noId.json()).error.code, 'bad_request');
  const noBool = await post(toggle, { id: 'mcp-alpha', disabled: 'yes' });
  assert.equal(noBool.status, 400);
  const missing = await post(toggle, { id: 'nope', disabled: true });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'not_found');
});

test('POST /remove deletes the entry and keeps the rest', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file });
  const res = await post(routeFor(routes, 'POST', '/remove'), { id: 'mcp-beta' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).id, 'mcp-beta');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('mcp-beta'), 'entry gone');
  assert.ok(text.includes('mcp-alpha'), 'sibling kept');
  assert.match(text, /# keep this comment/, 'comment kept');
});

test('POST endpoints reject malformed JSON', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file });
  const route = routeFor(routes, 'POST', '/toggle');
  const res = await route.fetch(new Request(`http://127.0.0.1${route.path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'bad_request');
});
