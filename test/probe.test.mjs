import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { probeConfig } from '../lib/probe.js';
import { resolveJsExprs, isJsExpr, evalJsExpr } from '../lib/jsexpr.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(dir, 'fixtures/mini-mcp-server.mjs');
const httpJs = path.join(dir, 'fixtures/mini-mcp-http.mjs');

test('stdio probe lists tools', async () => {
  const r = await probeConfig({ serverName: 'mini', transport: 'stdio', command: process.execPath, args: [serverJs] }, { timeoutMs: 15000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.toolCount, 2);
  assert.deepEqual(r.tools.sort(), ['echo', 'ping']);
});

test('http probe lists tools with session header', async () => {
  const { pathToFileURL } = await import('node:url');
  const { startMiniHttp } = await import(pathToFileURL(httpJs).href);
  const srv = startMiniHttp(0);
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  try {
    const r = await probeConfig({ serverName: 'mini', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp` }, { timeoutMs: 15000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.toolCount, 2);
  } finally { srv.close(); }
});

test('unreachable port fails with clear error', async () => {
  const r = await probeConfig({ serverName: 'x', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' }, { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('stdio command that exits immediately fails', async () => {
  const r = await probeConfig({ serverName: 'x', transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'] }, { timeoutMs: 15000 });
  assert.equal(r.ok, false);
});

// ---- !!js values: the loader hands back an inert marker, the probe must run it ----
//
// A credential written as `Authorization: !!js require('fs')...` arrives here as
// `{ __jsExpr: "require('fs')..." }`. Forwarding that to fetch sends
// `Authorization: [object Object]`, and GitHub answers 400 "Authorization header
// is badly formatted" — a valid credential reported as a broken one.

test('isJsExpr recognises the loader marker and nothing else', () => {
  assert.equal(isJsExpr({ __jsExpr: '1 + 1' }), true);
  assert.equal(isJsExpr({ __jsExpr: 5 }), false);
  assert.equal(isJsExpr({ other: 1 }), false);
  assert.equal(isJsExpr(['a']), false);
  assert.equal(isJsExpr('a'), false);
  assert.equal(isJsExpr(null), false);
});

test('evalJsExpr runs the expression with a require in scope', () => {
  assert.equal(evalJsExpr('1 + 1'), 2);
  assert.equal(evalJsExpr("'a' + 'b'"), 'ab');
  assert.match(evalJsExpr("require('node:path').basename('/x/y.txt')"), /y\.txt/);
  // An expression, not a statement: `throw` on its own is a syntax error here,
  // and a syntax error must surface as a failed evaluation, not a crash.
  assert.throws(() => evalJsExpr('(function(){ throw new Error("boom"); })()'), /boom/);
  assert.throws(() => evalJsExpr('this is not javascript'), /SyntaxError/);
});

test('resolveJsExprs replaces markers in headers, env and arrays without mutating the input', () => {
  const config = {
    serverName: 'x',
    transport: 'streamable-http',
    url: 'https://x/mcp',
    headers: { Authorization: { __jsExpr: "'Bearer ' + 'tok'" } },
    env: { A: { __jsExpr: '1 + 1' }, B: 'literal' },
    args: [{ __jsExpr: "'--flag'" }, 'plain'],
  };
  const r = resolveJsExprs(config);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.config.headers.Authorization, 'Bearer tok');
  assert.equal(r.config.env.A, 2);
  assert.equal(r.config.env.B, 'literal');
  assert.deepEqual(r.config.args, ['--flag', 'plain']);
  assert.deepEqual(r.resolved.sort(), ['args[0]', 'env.A', 'headers.Authorization']);
  assert.equal(isJsExpr(config.headers.Authorization), true, 'the input must not be mutated');
});

test('resolveJsExprs reports the failing path instead of throwing', () => {
  const boom = resolveJsExprs({ headers: { Authorization: { __jsExpr: '(function(){ throw new Error("nope"); })()' } } });
  assert.equal(boom.ok, false);
  assert.match(boom.error, /headers\.Authorization/);
  assert.match(boom.error, /nope/);

  const syntax = resolveJsExprs({ headers: { Authorization: { __jsExpr: 'not javascript at all' } } });
  assert.equal(syntax.ok, false);
  assert.match(syntax.error, /headers\.Authorization/);

  const obj = resolveJsExprs({ headers: { Authorization: { __jsExpr: '({ a: 1 })' } } });
  assert.equal(obj.ok, false);
  assert.match(obj.error, /headers\.Authorization/);
  assert.match(obj.error, /object/);
});

test('a config with no !!js passes through unchanged', () => {
  const config = { serverName: 'x', transport: 'stdio', command: 'node', args: ['-v'] };
  const r = resolveJsExprs(config);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, config);
  assert.deepEqual(r.resolved, []);
});

test('http probe resolves a !!js header and reaches the server', async () => {
  const { pathToFileURL } = await import('node:url');
  const { startMiniHttp } = await import(pathToFileURL(httpJs).href);
  const srv = startMiniHttp(0, { requireAuth: 'Bearer test-token' });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  try {
    const r = await probeConfig({
      serverName: 'mini', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: { __jsExpr: "'Bearer ' + 'test-token'" } },
    }, { timeoutMs: 15000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.toolCount, 2);
  } finally { srv.close(); }
});

test('http probe fails clearly when the !!js expression cannot be evaluated', async () => {
  const { pathToFileURL } = await import('node:url');
  const { startMiniHttp } = await import(pathToFileURL(httpJs).href);
  const srv = startMiniHttp(0, { requireAuth: 'Bearer test-token' });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  try {
    const r = await probeConfig({
      serverName: 'mini', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: { __jsExpr: '(function(){ throw new Error("bad credential expression"); })()' } },
    }, { timeoutMs: 15000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /headers\.Authorization/);
    assert.match(r.error, /bad credential expression/);
  } finally { srv.close(); }
});

test('a literal Authorization header still reaches the server', async () => {
  const { pathToFileURL } = await import('node:url');
  const { startMiniHttp } = await import(pathToFileURL(httpJs).href);
  const srv = startMiniHttp(0, { requireAuth: 'Bearer test-token' });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  try {
    const r = await probeConfig({
      serverName: 'mini', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: 'Bearer test-token' },
    }, { timeoutMs: 15000 });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { srv.close(); }
});
