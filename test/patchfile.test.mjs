import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySurgery, applySurgeryAsync, renderEntryRow } from '../lib/patchfile.js';
import { findRow } from '../lib/surgery.js';
import { loadPatchText } from '../lib/dump.js';
import * as patchfileApi from '../lib/patchfile.js';

function tmpPatch(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmcp-'));
  const file = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(file, content);
  return file;
}
const SAMPLE = fs.readFileSync(new URL('./fixtures/patch-sample.yml', import.meta.url), 'utf8');

test('appendEntry writes, backs up, and validates', async () => {
  const file = tmpPatch(SAMPLE);
  const row = renderEntryRow({ id: 'mcp-delta', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'delta', transport: 'stdio', command: 'npx', args: ['-y', 'delta'] } });
  const r = await applySurgeryAsync({ file, operation: { type: 'appendEntry', row } });
  assert.equal(r.applied, true);
  assert.ok(fs.existsSync(file + '.bak'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('serverName: delta'));
});

test('remove of missing id throws and leaves live file untouched', async () => {
  const file = tmpPatch(SAMPLE);
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(() => applySurgeryAsync({ file, operation: { type: 'remove', id: 'nope' }, validate: false }), /entry not found/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('setDisabled works via pipeline (validate:false)', async () => {
  const file = tmpPatch(SAMPLE);
  const r = applySurgery({ file, operation: { type: 'setDisabled', id: 'mcp-gamma', value: false } });
  assert.equal(r.applied, true);
  assert.ok(fs.readFileSync(file, 'utf8').match(/mcp-gamma[\s\S]*?disabled:\s*false/));
});

test('sync pipeline refuses the validation gate', () => {
  const file = tmpPatch(SAMPLE);
  assert.throws(() => applySurgery({ file, operation: { type: 'setDisabled', id: 'mcp-gamma', value: true }, validate: true }), /applySurgeryAsync/);
});

test('stale expectMtime aborts with FileChangedExternally', async () => {
  const file = tmpPatch(SAMPLE);
  await assert.rejects(
    () => applySurgeryAsync({ file, operation: { type: 'setDisabled', id: 'mcp-gamma', value: true }, validate: false, expectMtime: 1 }),
    /FileChangedExternally/,
  );
});

test('failing validation keeps candidate file and live file untouched', async () => {
  const file = tmpPatch(SAMPLE);
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(() => applySurgeryAsync({
    file,
    validate: true,
    operation: { type: 'appendEntry', row: { id: 'x', name: 'y', configLines: ['config:', '\tbroken: "unclosed'] } },
  }), /candidate failed validation/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(fs.existsSync(file + '.candidate'), 'candidate kept for inspection');
});

test('validation-gated happy path succeeds on a real parseable candidate', async () => {
  const file = tmpPatch(SAMPLE);
  const row = renderEntryRow({ id: 'mcp-delta', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'delta', transport: 'stdio', command: 'npx' } });
  const r = await applySurgeryAsync({ file, operation: { type: 'appendEntry', row } });
  assert.equal(r.applied, true);
  assert.ok(!fs.existsSync(file + '.candidate'), 'candidate cleaned up after success');
});

test('renderEntryRow keeps !!js lines verbatim and sorts config keys', () => {
  const row = renderEntryRow({
    id: 'x', name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'x', transport: 'stdio', command: 'npx',
      env: { T: "!!js require('fs').readFileSync('t.txt','utf8').trim()" },
    },
  });
  const text = row.configLines.join('\n');
  assert.ok(text.includes("!!js require('fs')"));
  const keys = row.configLines.filter(l => /^ {4}\w/.test(l)).map(l => l.trim().split(':')[0]);
  assert.deepEqual(keys, [...keys].sort());
});

test('renderEntryRow quotes values that are unsafe as YAML plain scalars', () => {
  const row = renderEntryRow({
    id: 'x', name: 'n',
    config: {
      serverName: 'x', transport: 'stdio', command: 'npx',
      args: ['@scope/pkg', 'plain', 'true', '123', 'with space', '#hash', '~', '-y'],
    },
  });
  const text = row.configLines.join('\n');
  assert.ok(text.includes('    - "@scope/pkg"'), text);
  assert.ok(text.includes('    - plain'), text);
  assert.ok(text.includes('    - "true"'), text);
  assert.ok(text.includes('    - "123"'), text);
  assert.ok(text.includes('    - "with space"'), text);
  assert.ok(text.includes('    - "#hash"'), text);
  assert.ok(text.includes('    - "~"'), text);
  assert.ok(text.includes('    - -y'), '-y stays a legal plain scalar');
});

test('an appended row carrying a scoped package survives the validation gate', async () => {
  const file = tmpPatch(SAMPLE);
  const row = renderEntryRow({
    id: 'mcp-everything', name: '@deepseek-ai/dsh-mcp-client',
    config: {
      serverName: 'everything', transport: 'stdio', command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    },
  });
  const r = await applySurgeryAsync({ file, operation: { type: 'appendEntry', row } });
  assert.equal(r.applied, true);
  assert.match(fs.readFileSync(file, 'utf8'), /@modelcontextprotocol\/server-everything/);
});

test('applySurgeryAsync runs preCommit and aborts the write when it throws', async () => {
  const file = tmpPatch(SAMPLE);
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(() => applySurgeryAsync({
    file,
    operation: { type: 'replaceConfig', id: 'mcp-gamma', fragment: 'serverName: gamma\ntransport: stdio\ncommand: node' },
    preCommit: async () => { throw new Error('semantic veto'); },
  }), /semantic veto/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the live file is untouched');
});

test('applySurgeryAsync applies the replaceConfig operation', async () => {
  const file = tmpPatch(SAMPLE);
  const r = await applySurgeryAsync({
    file,
    operation: { type: 'replaceConfig', id: 'mcp-gamma', fragment: 'serverName: gamma\ntransport: stdio\ncommand: node' },
  });
  assert.equal(r.applied, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('serverName: gamma'));
  assert.ok(!text.includes('GAMMA_TOKEN'));
  assert.ok(text.includes('mcp-alpha') && text.includes('mcp-beta'), 'siblings untouched');
});

// What `add` is for: the row must be mountable by the harness loader AND
// readable back by this plugin's own reader. Asserting only that the text
// contains `serverName: delta` let a flat, unmountable entry pass unnoticed.
test('an appended row is mountable and survives a read-back with its config', async () => {
  const file = tmpPatch(SAMPLE);
  const row = renderEntryRow({
    id: 'mcp-delta', name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'delta', transport: 'stdio', command: 'npx', args: ['-y', 'delta-mcp'] },
  });
  await applySurgeryAsync({ file, operation: { type: 'appendEntry', row } });
  const text = fs.readFileSync(file, 'utf8');

  assert.equal(findRow(text, 'mcp-delta').kind, 'insert-row', 'a bare entry matching no row is skipped by the loader');

  const { entries } = await loadPatchText(text);
  const entry = entries.find((e) => e.id === 'mcp-delta');
  assert.ok(entry, 'the appended entry must be readable back');
  assert.equal(entry.config.serverName, 'delta');
  assert.deepEqual(entry.config.args, ['-y', 'delta-mcp']);
});

// "A rejected candidate never reaches your live patch" is the plugin's whole
// promise, and the append shape is exactly what slipped past the gate. These
// two tests pin the gate and the seam that feeds it.
test('appendedRowProblem names why a candidate row would not mount', async () => {
  const cases = [
    ['- id: mcp-delta\n  name: n\n  config:\n    serverName: delta\n', /insert list/],
    ['- insert:\n    - id: mcp-delta\n      name: n\n      serverName: delta\n', /usable config/],
  ];
  for (const [text, re] of cases) {
    const { entries } = await loadPatchText(text);
    assert.match(patchfileApi.appendedRowProblem(text, entries, 'mcp-delta'), re, text);
  }

  const good = '- insert:\n    - id: mcp-delta\n      name: n\n      config:\n        serverName: delta\n';
  const { entries } = await loadPatchText(good);
  assert.equal(patchfileApi.appendedRowProblem(good, entries, 'mcp-delta'), undefined);
});

test('applySurgeryAsync hands preCommit the candidate text and its parsed entries', async () => {
  const file = tmpPatch(SAMPLE);
  let seen;
  const row = renderEntryRow({
    id: 'mcp-delta', name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'delta', transport: 'stdio', command: 'npx' },
  });
  await applySurgeryAsync({
    file,
    operation: { type: 'appendEntry', row },
    preCommit: async (text, parsed) => { seen = { text, parsed }; },
  });
  assert.match(seen.text, /mcp-delta/);
  assert.ok(seen.parsed?.entries?.some((e) => e.id === 'mcp-delta'),
    'preCommit cannot verify the config without the parsed entries');
});
