import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  } finally { fs.rmSync(copy, { force: true }); }
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
