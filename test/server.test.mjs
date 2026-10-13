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
    command: 'npx', args: ['-y', 'alpha-mcp'], url: '', disabled: false, live: true,
    configText: "serverName: alpha\ntransport: stdio\ncommand: npx\nargs: ['-y', 'alpha-mcp']",
    jsExprs: [], editable: true, editReason: '' });
  const beta = body.servers.find((s) => s.id === 'mcp-beta');
  assert.equal(beta.live, false);
  const gamma = body.servers.find((s) => s.id === 'mcp-gamma');
  assert.equal(gamma.disabled, true);
  assert.equal(gamma.env, undefined, 'servers[] must not carry env');
});

test('GET /servers never leaks a credential value', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const text = await (await get(routeFor(routes, 'GET', '/servers'))).text();
  assert.ok(!text.includes('readFileSync'), 'the raw expression must not reach the browser');
  // The credential FILE reference is exposed on purpose: the panel shows
  // `GAMMA_TOKEN: !!js «0»` and the hint line has to say which file it reads,
  // otherwise the placeholder is meaningless. The file's contents never are.
  assert.ok(text.includes('credential file: C:/Users/x/gamma-token.txt'));
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

test('POST /probe reports a failure reason for an unknown id', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const res = await post(routeFor(routes, 'POST', '/probe'), { id: 'nope' });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'not_found');
});

test('POST /probe rejects a missing id', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const res = await post(routeFor(routes, 'POST', '/probe'), {});
  assert.equal(res.status, 400);
});

test('POST /probe answers 200 with an error field when the handshake fails', async () => {
  // The fixture's beta row points at https://example.invalid/mcp, which cannot resolve.
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const res = await post(routeFor(routes, 'POST', '/probe'), { id: 'mcp-beta', timeout_s: 5 });
  assert.equal(res.status, 200, 'a failed handshake is still a successful request');
  const body = await res.json();
  assert.equal(body.id, 'mcp-beta');
  assert.equal(body.toolCount, 0);
  assert.deepEqual(body.tools, []);
  assert.equal(typeof body.error, 'string');
  assert.ok(body.error.length > 0);
});

// The add route probes the new server. Real probing spawns npx and downloads a
// package, so these tests inject a stub: the seam exists for exactly this.
const stubProbe = async () => ({ ok: true, toolCount: 3, tools: ['a', 'b', 'c'] });

test('POST /add dry-runs by default and does not touch the file', async () => {
  const file = copyFixture();
  const before = fs.readFileSync(file, 'utf8');
  const beforeMtime = fs.statSync(file).mtimeMs;
  const routes = createRoutes(fakeCtx(), { patchPath: file, probe: stubProbe });
  const res = await post(routeFor(routes, 'POST', '/add'), { input: '@modelcontextprotocol/server-everything' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.preview, 'string');
  assert.match(body.preview, /- id: /);
  assert.match(body.preview, /dsh-mcp-client/);
  assert.equal(body.written, undefined, 'dry run must not report a write');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'file content unchanged');
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime, 'mtime unchanged');
});

test('POST /add rejects a missing input', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture, probe: stubProbe });
  const res = await post(routeFor(routes, 'POST', '/add'), {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'bad_request');
});

test('POST /add with confirm writes the entry and reports the probe', async () => {
  const file = copyFixture();
  const seen = [];
  const probe = async (config) => { seen.push(config); return { ok: true, toolCount: 3, tools: ['a', 'b', 'c'] }; };
  const routes = createRoutes(fakeCtx(), { patchPath: file, probe });
  const res = await post(routeFor(routes, 'POST', '/add'), {
    input: '@modelcontextprotocol/server-everything', confirm: true,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.written, true);
  assert.ok(body.backup.endsWith('.bak'));
  assert.deepEqual(body.probe, { ok: true, toolCount: 3 });
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /server-everything/);
  assert.match(text, /# keep this comment/, 'existing comments kept');

  // The probe must run against what landed on disk, not the in-memory entry.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].serverName, 'everything', 'the probe must see the persisted config');
  assert.deepEqual(seen[0].args, ['-y', '@modelcontextprotocol/server-everything']);
});

// ---- the edit route: same fixture, same throwaway-copy discipline ----

test('GET /servers exposes the editable subtree with placeholders', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const res = await get(routeFor(routes, 'GET', '/servers'));
  const body = await res.json();
  assert.equal(typeof body.mtimeMs, 'number');
  const gamma = body.servers.find((s) => s.id === 'mcp-gamma');
  assert.equal(gamma.editable, true);
  assert.equal(gamma.editReason, '');
  assert.ok(gamma.configText.includes('GAMMA_TOKEN: !!js «0»'));
  assert.ok(!gamma.configText.includes('readFileSync'));
  assert.deepEqual(gamma.jsExprs, ['credential file: C:/Users/x/gamma-token.txt']);
});

test('POST /update dry-runs, then writes and probes', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file, probe: stubProbe });
  const update = routeFor(routes, 'POST', '/update');

  const dry = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio\ncommand: node' });
  assert.equal(dry.status, 200);
  assert.equal((await dry.json()).written, false);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('toolCallTimeoutMs'), 'dry run must not write');

  const ok = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio\ncommand: node\ntoolCallTimeoutMs: 90000', confirm: true });
  const body = await ok.json();
  assert.equal(body.written, true);
  assert.ok(body.backup.endsWith('.bak'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('toolCallTimeoutMs: 90000'));
  assert.match(text, /# keep this comment/, 'comments survive');
  assert.deepEqual(body.probe, { ok: true, toolCount: 3 });
});

test('POST /update keeps the !!js expression when the panel round-trips a placeholder', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file, probe: stubProbe });
  const view = await (await get(routeFor(routes, 'GET', '/servers'))).json();
  const gamma = view.servers.find((s) => s.id === 'mcp-gamma');

  const res = await post(routeFor(routes, 'POST', '/update'), {
    id: 'mcp-gamma', config: `${gamma.configText}\ntoolCallTimeoutMs: 90000`, confirm: true, expectMtime: view.mtimeMs,
  });
  assert.equal(res.status, 200);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes("GAMMA_TOKEN: !!js require('fs')"), 'the expression came back verbatim');
  assert.ok(text.includes('toolCallTimeoutMs: 90000'));
});

test('POST /update rejects a new !!js expression, a bad rule and a stale read', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file, probe: stubProbe });
  const update = routeFor(routes, 'POST', '/update');

  const js = await post(update, { id: 'mcp-gamma', config: "serverName: gamma\ntransport: stdio\ncommand: node\nenv:\n  X: !!js process.env.HOME" });
  assert.equal(js.status, 400);
  assert.equal((await js.json()).error.code, 'js_expression_forbidden');

  const rules = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio' });
  assert.equal(rules.status, 400);
  assert.equal((await rules.json()).error.code, 'rules_failed');

  const secret = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: streamable-http\nurl: https://x/mcp\nheaders:\n  Authorization: Bearer abc' });
  assert.equal(secret.status, 400);
  assert.equal((await secret.json()).error.code, 'hardcoded_secret');

  const stale = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio\ncommand: node', confirm: true, expectMtime: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'file_changed');

  const badBody = await post(update, { id: 'mcp-gamma' });
  assert.equal(badBody.status, 400);
  assert.equal((await badBody.json()).error.code, 'bad_request');

  const missing = await post(update, { id: 'nope', config: 'a: 1' });
  assert.equal(missing.status, 404);
});
