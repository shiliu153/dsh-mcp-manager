import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { probeConfig } from '../lib/probe.js';

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
