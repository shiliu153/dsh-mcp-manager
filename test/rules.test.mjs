import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEntry, checkSecrets, SERVER_NAME_RE } from '../lib/rules.js';

const base = { serverName: 'alpha', transport: 'stdio', command: 'npx' };

test('serverName pattern', () => {
  assert.ok(SERVER_NAME_RE.test('a-b_C9'));
  assert.ok(!SERVER_NAME_RE.test('has space'));
  assert.ok(!SERVER_NAME_RE.test('x'.repeat(33)));
  assert.ok(SERVER_NAME_RE.test('x'.repeat(32)));
});

test('valid stdio entry passes', () => {
  const r = validateEntry(base);
  assert.deepEqual(r.errors, []);
});

test('stdio without command fails', () => {
  const { command, ...noCmd } = base;
  const r = validateEntry(noCmd);
  assert.ok(r.errors.some(e => e.includes('command')));
});

test('http without url fails; http with command warns', () => {
  const r = validateEntry({ serverName: 'w', transport: 'streamable-http' });
  assert.ok(r.errors.some(e => e.includes('url')));
  const r2 = validateEntry({ serverName: 'w', transport: 'streamable-http', url: 'https://x/mcp', command: 'npx' });
  assert.ok(r2.warnings.some(e => e.includes('command')));
});

test('unknown transport fails', () => {
  const r = validateEntry({ serverName: 'w', transport: 'sse', url: 'https://x' });
  assert.ok(r.errors.some(e => e.includes('transport')));
});

test('toolCallTimeoutMs and reconnect ranges enforced', () => {
  const r = validateEntry({ ...base, toolCallTimeoutMs: 0 });
  assert.ok(r.errors.some(e => e.includes('toolCallTimeoutMs')));
  const r2 = validateEntry({ ...base, reconnect: { initialDelayMs: 0 } });
  assert.ok(r2.errors.some(e => e.includes('initialDelayMs')));
  const r3 = validateEntry({ ...base, reconnect: { maxAttempts: 1.5 } });
  assert.ok(r3.errors.some(e => e.includes('maxAttempts')));
});

test('hardcoded secret in env or headers fails', () => {
  const r = validateEntry({ ...base, env: { GITHUB_TOKEN: 'ghp_literal123' } });
  assert.ok(r.errors.some(e => e.includes('GITHUB_TOKEN')));
  const r2 = validateEntry({ serverName: 'w', transport: 'streamable-http', url: 'https://x', headers: { Authorization: 'Bearer abc' } });
  assert.ok(r2.errors.some(e => e.includes('Authorization')));
});

test('non-secret env values pass through fine', () => {
  const r = validateEntry({ ...base, env: { DEBUG: '1', NODE_ENV: 'production' } });
  assert.deepEqual(r.errors, []);
});

test('checkSecrets accepts !!js reference, rejects literal', () => {
  const ok = checkSecrets("  env:\n      GITHUB_TOKEN: !!js require('fs').readFileSync('t.txt','utf8').trim()\n");
  assert.equal(ok.ok, true);
  const bad = checkSecrets("      GITHUB_TOKEN: ghp_literal\n");
  assert.equal(bad.ok, false);
});
