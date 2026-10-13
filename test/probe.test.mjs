import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probeConfig } from '../lib/probe.js';
import { resolveJsExprs, isJsExpr, evalJsExpr } from '../lib/jsexpr.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(dir, 'fixtures/mini-mcp-server.mjs');
const httpJs = path.join(dir, 'fixtures/mini-mcp-http.mjs');
const httpOnlyJs = path.join(dir, 'fixtures/http-only-server.mjs');

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

// ---- a package that is not a stdio server at all ------------------------------
//
// Measured against the live registry: `ai.ankimcp/anki-mcp-server` declares
// `packages[0].transport.type: "stdio"`, but the package prints
// "Server running on: http://127.0.0.1:3000" and never reads stdin. The probe
// cannot know the registry is wrong, but it must not hide the evidence either:
// the banner goes to STDOUT, which the probe used to discard while keeping only
// stderr, so the one line that explained everything never reached the user.

test('a stdio server that only prints an HTTP banner keeps the banner', async () => {
  const r = await probeConfig({ serverName: 'http-only', transport: 'stdio', command: process.execPath, args: [httpOnlyJs] }, { timeoutMs: 6000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.match(r.detail, /Server running on: http:\/\/127\.0\.0\.1:3000/, 'stdout must not be thrown away');
});

test('an HTTP endpoint in the output produces a transport hint', async () => {
  const r = await probeConfig({ serverName: 'http-only', transport: 'stdio', command: process.execPath, args: [httpOnlyJs] }, { timeoutMs: 6000 });
  assert.match(r.hint, /may not be a stdio server/);
  assert.match(r.hint, /http:\/\/127\.0\.0\.1:3000/);
});

test('a plain crash yields no transport hint', async () => {
  const r = await probeConfig({ serverName: 'x', transport: 'stdio', command: process.execPath, args: ['-e', 'process.stderr.write("boom\\n"); process.exit(3)'] }, { timeoutMs: 15000 });
  assert.equal(r.ok, false);
  assert.equal(r.hint, '');
  assert.match(r.detail, /boom/, 'stderr is still kept');
});

// The probe wraps `.cmd`/`.bat` in `cmd.exe /c`, so its direct child is the
// wrapper and the real server is a GRANDCHILD. `child.kill()` signalled only the
// wrapper, and the orphaned server kept holding its port — the next probe then
// died with EADDRINUSE and reported "server exited early (code 1)", hiding the
// real reason. Reproduced in isolation before this test existed.
test('the probe kills the process tree, not only the cmd.exe wrapper', {
  skip: process.platform === 'win32' ? false : 'the cmd.exe wrapper only exists on Windows',
}, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-tree-'));
  const pidFile = path.join(work, 'pid.txt');
  const shim = path.join(work, 'stubborn.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${httpOnlyJs}" "${pidFile}" %*\r\n`);
  try {
    const r = await probeConfig({ serverName: 'http-only', transport: 'stdio', command: shim, args: [] }, { timeoutMs: 6000 });
    assert.equal(r.ok, false);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0, 'the fixture must have recorded its pid');
    // Give the kill a moment to land, then assert the process is really gone.
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      await new Promise((res) => setTimeout(res, 100));
      try { process.kill(pid, 0); } catch { alive = false; }
    }
    assert.equal(alive, false, `the server (pid ${pid}) survived the probe as an orphan`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
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
