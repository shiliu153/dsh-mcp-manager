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

test('add --yes writes the entry', () => {
  const copy = path.join(dir, 'tmp-add2.yml');
  fs.copyFileSync(sample, copy);
  try {
    const r = run(['add', 'foo-mcp', '--file', copy, '--yes', '--no-probe']);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(fs.readFileSync(copy, 'utf8').includes('foo-mcp'));
  } finally { fs.rmSync(copy, { force: true }); }
});

test('usage error exits 2', () => {
  assert.equal(run(['bogus-command']).status, 2);
});
