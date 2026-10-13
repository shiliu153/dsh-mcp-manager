import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMiniRegistry } from './fixtures/mini-registry.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(dir, '../cli/mcp.js');
const sample = path.join(dir, 'fixtures/patch-sample.yml');
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60000 });

test('list prints table and --json entries', () => {
  const r = run(['list', '--file', sample]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(r.stdout.includes('mcp-alpha') && r.stdout.includes('stdio'));
  const j = JSON.parse(run(['list', '--file', sample, '--json']).stdout);
  assert.equal(j.entries.length, 3);
  assert.equal(j.entries.find(e => e.id === 'mcp-gamma').disabled, true);
});

test('list masks !!js credential values', () => {
  const out = run(['list', '--file', sample, '--json']).stdout;
  assert.ok(!out.includes("readFileSync('C:/Users/x/gamma-token.txt'"), 'must not leak expression');
  const j = JSON.parse(out);
  const gamma = j.entries.find(e => e.id === 'mcp-gamma');
  assert.equal(gamma.config.env.GAMMA_TOKEN, 'B*****');
});

test('enable/disable roundtrip on a copy', () => {
  const copy = path.join(dir, 'tmp-work.yml');
  fs.copyFileSync(sample, copy);
  try {
    assert.equal(run(['disable', 'mcp-alpha', '--file', copy, '--yes']).status, 0);
    assert.equal(blockDisabled(copy, 'mcp-alpha'), true);
    assert.equal(run(['enable', 'mcp-alpha', '--file', copy, '--yes']).status, 0);
    assert.equal(blockDisabled(copy, 'mcp-alpha'), false);
    assert.equal(blockDisabled(copy, 'mcp-gamma'), true, 'gamma untouched');
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(copy + '.bak', { force: true });
  }
});

import { findRow } from '../lib/surgery.js';

function blockDisabled(file, id) {
  const text = fs.readFileSync(file, 'utf8');
  const row = findRow(text, id);
  if (!row) throw new Error('row not found: ' + id);
  return /disabled:\s*true/.test(text.split('\n').slice(row.startLine, row.endLine + 1).join('\n'));
}

test('validate reports ok for well-formed entry, fails for unknown id', () => {
  assert.equal(run(['validate', 'mcp-alpha', '--file', sample]).status, 0);
  assert.equal(run(['validate', 'nope', '--file', sample]).status, 1);
});

test('schema prints field rules', () => {
  const r = run(['schema']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('serverName') && r.stdout.includes('streamable-http'));
});

test('add dry-run prints entry and does not write', () => {
  const copy = path.join(dir, 'tmp-add.yml');
  fs.copyFileSync(sample, copy);
  try {
    const r = run(['add', 'foo-mcp', '--file', copy]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(r.stdout.includes('serverName: foo'));
    assert.ok(!fs.readFileSync(copy, 'utf8').includes('foo-mcp'), 'dry run must not write');
  } finally { fs.rmSync(copy, { force: true }); }
});

test('add --yes writes a row the plugin can read back with its config', () => {
  const copy = path.join(dir, 'tmp-add2.yml');
  fs.copyFileSync(sample, copy);
  try {
    const r = run(['add', 'foo-mcp', '--file', copy, '--yes', '--no-probe']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const text = fs.readFileSync(copy, 'utf8');
    assert.equal(findRow(text, 'mcp-foo').kind, 'insert-row', 'the loader only mounts insert rows');

    const j = JSON.parse(run(['list', '--file', copy, '--json']).stdout);
    const entry = j.entries.find(e => e.id === 'mcp-foo');
    assert.ok(entry, 'the written entry must be readable back');
    assert.equal(entry.config.serverName, 'foo');
    assert.deepEqual(entry.config.args, ['-y', 'foo-mcp']);
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(copy + '.bak', { force: true });
  }
});

test('add refuses a serverName that is already registered', () => {
  const copy = path.join(dir, 'tmp-add-dup.yml');
  fs.copyFileSync(sample, copy);
  try {
    const r = run(['add', 'alpha-mcp', '--file', copy, '--yes', '--no-probe']);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /duplicate serverName: alpha/);
    assert.ok(!r.stderr.includes('at applySurgeryAsync'), 'a refusal is reported, not dumped as a crash');
    assert.ok(!r.stderr.includes('candidate failed validation'), 'the reason alone, not the pipeline internals');
    assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(sample, 'utf8'), 'the live file is untouched');
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(copy + '.bak', { force: true });
    fs.rmSync(copy + '.candidate', { force: true });
  }
});

test('usage error exits 2', () => {
  assert.equal(run(['bogus-command']).status, 2);
});

test('show prints the subtree verbatim so it can be piped back', () => {
  const r = run(['show', 'mcp-gamma', '--file', sample]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(r.stdout.includes("GAMMA_TOKEN: !!js require('fs')"),
    'verbatim: a masked value piped back into `edit` would silently corrupt the entry');
  assert.ok(!r.stdout.includes('config:'), 'the subtree only, not the config: line');
});

test('show --masked and --json', () => {
  const masked = run(['show', 'mcp-gamma', '--masked', '--file', sample]);
  assert.equal(masked.status, 0, masked.stderr || masked.stdout);
  assert.ok(masked.stdout.includes('GAMMA_TOKEN: !!js «0»'));
  assert.ok(!masked.stdout.includes('readFileSync'));
  const j = JSON.parse(run(['show', 'mcp-gamma', '--json', '--file', sample]).stdout);
  assert.equal(j.id, 'mcp-gamma');
  assert.equal(j.kind, 'block');
  assert.equal(j.indent, 4);
});

test('show fails for an unknown id', () => {
  const r = run(['show', 'nope', '--file', sample]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /entry not found: nope/);
});

test('edit dry-runs and only writes with --yes', () => {
  const copy = path.join(dir, 'tmp-edit-work.yml');
  const cfg = path.join(dir, 'tmp-edit-config.yml');
  fs.copyFileSync(sample, copy);
  fs.writeFileSync(cfg, 'serverName: gamma\ntransport: stdio\ncommand: node\ntoolCallTimeoutMs: 90000\n');
  try {
    const dry = run(['edit', 'mcp-gamma', '--config', cfg, '--file', copy]);
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.ok(dry.stdout.includes('DRY RUN'));
    assert.ok(!fs.readFileSync(copy, 'utf8').includes('toolCallTimeoutMs'));

    const wet = run(['edit', 'mcp-gamma', '--config', cfg, '--yes', '--file', copy]);
    assert.equal(wet.status, 0, wet.stderr || wet.stdout);
    assert.match(wet.stdout, /updated mcp-gamma/);
    const text = fs.readFileSync(copy, 'utf8');
    assert.ok(text.includes('toolCallTimeoutMs: 90000'));
    assert.ok(text.includes('mcp-alpha') && text.includes('mcp-beta'), 'siblings untouched');
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(copy + '.bak', { force: true });
    fs.rmSync(cfg, { force: true });
  }
});

test('edit refuses a hardcoded secret and an unknown id', () => {
  const copy = path.join(dir, 'tmp-edit-secret.yml');
  const cfg = path.join(dir, 'tmp-edit-secret-config.yml');
  fs.copyFileSync(sample, copy);
  fs.writeFileSync(cfg, 'serverName: gamma\ntransport: streamable-http\nurl: https://x/mcp\nheaders:\n  Authorization: Bearer abc\n');
  try {
    const r = run(['edit', 'mcp-gamma', '--config', cfg, '--yes', '--file', copy]);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /FAIL hardcoded_secret/);
    assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(sample, 'utf8'), 'the live file is untouched');

    const missing = run(['edit', 'nope', '--config', cfg, '--file', copy]);
    assert.equal(missing.status, 1);
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(cfg, { force: true });
  }
});

// ---- market: search and install ----------------------------------------------
//
// The mini registry runs in THIS process, so the CLI must be spawned
// asynchronously: `run()` above uses spawnSync, which blocks the event loop and
// would starve the very server the child is trying to reach.
function runAsync(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: 1, stdout, stderr: stderr + e.message }); });
  });
}

function withRegistry(fn) {
  return async () => {
    const server = await startMiniRegistry(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
  };
}

test('search lists installable hits with their execution surface', withRegistry(async (base) => {
  const r = await runAsync(['search', 'anki', '--registry-base', base]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ai\.ankimcp\/anki-mcp-server@0\.27\.0/);
  assert.match(r.stdout, /npx -y @ankimcp\/anki-mcp-server@0\.27\.0/);
}));

test('search filters out an entry it cannot install, and says so when nothing is left', withRegistry(async (base) => {
  const r = await runAsync(['search', 'sse-only', '--registry-base', base]);
  assert.match(r.stdout + r.stderr, /no installable registry entries/);
}));

test('search --json is machine-readable', withRegistry(async (base) => {
  const r = await runAsync(['search', 'anki', '--registry-base', base, '--json']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.results[0].registryName, 'ai.ankimcp/anki-mcp-server');
  assert.equal(j.results[0].transport, 'stdio');
  assert.deepEqual(j.results[0].gaps, []);
}));

test('search names the credentials a hit still needs', withRegistry(async (base) => {
  const r = await runAsync(['search', 'needs-key', '--registry-base', base]);
  assert.match(r.stdout, /needs credentials: Authorization/);
}));

test('search reports an unreachable registry with a non-zero exit', () => {
  const r = run(['search', 'x', '--registry-base', 'http://127.0.0.1:1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /registry unreachable/);
});

test('install dry-runs by default and writes nothing', withRegistry(async (base) => {
  const copy = path.join(dir, 'tmp-market.yml');
  fs.copyFileSync(sample, copy);
  try {
    const before = fs.readFileSync(copy, 'utf8');
    const r = await runAsync(['install', 'ai.ankimcp/anki-mcp-server', '--registry-base', base, '--file', copy]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /dry run/);
    assert.match(r.stdout, /anki-mcp-server@0\.27\.0/);
    assert.equal(fs.readFileSync(copy, 'utf8'), before);
  } finally { fs.rmSync(copy, { force: true }); fs.rmSync(copy + '.bak', { force: true }); }
}));

test('install --yes writes a mountable insert row', withRegistry(async (base) => {
  const copy = path.join(dir, 'tmp-market.yml');
  fs.copyFileSync(sample, copy);
  try {
    const r = await runAsync(['install', 'ai.ankimcp/anki-mcp-server', '--registry-base', base, '--file', copy, '--yes', '--no-probe']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /written/);
    assert.equal(findRow(fs.readFileSync(copy, 'utf8'), 'mcp-anki-mcp-server').kind, 'insert-row');
  } finally { fs.rmSync(copy, { force: true }); fs.rmSync(copy + '.bak', { force: true }); }
}));

test('install names the credentials still to be filled', withRegistry(async (base) => {
  const copy = path.join(dir, 'tmp-market.yml');
  fs.copyFileSync(sample, copy);
  try {
    const r = await runAsync(['install', 'ai.x/needs-key', '--registry-base', base, '--file', copy]);
    assert.match(r.stdout, /needs secret: Authorization/);
  } finally { fs.rmSync(copy, { force: true }); fs.rmSync(copy + '.bak', { force: true }); }
}));

test('install refuses an entry it cannot run', withRegistry(async (base) => {
  const r = await runAsync(['install', 'ai.x/sse-only', '--registry-base', base, '--file', sample]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not installable: sse/);
}));

test('install flags a server that is already registered', withRegistry(async (base) => {
  const copy = path.join(dir, 'tmp-market.yml');
  fs.copyFileSync(sample, copy);
  try {
    const r = await runAsync(['install', 'ai.ankimcp/anki-mcp-server', '--registry-base', base, '--file', copy, '--yes', '--no-probe']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const again = await runAsync(['install', 'ai.ankimcp/anki-mcp-server', '--registry-base', base, '--file', copy]);
    assert.match(again.stdout, /already registered as mcp-anki-mcp-server/);
    assert.match(again.stdout, /\(current\)/, 'the same pinned version must not be reported as drift');
  } finally { fs.rmSync(copy, { force: true }); fs.rmSync(copy + '.bak', { force: true }); }
}));
