import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTopBlocks, findRow, removeEntry, setDisabled, appendEntry, readConfigBlock, replaceConfigBlock } from '../lib/surgery.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(path.join(dir, 'fixtures/patch-sample.yml'), 'utf8');

test('parseTopBlocks finds insert block with 2 rows and bare block', () => {
  const blocks = parseTopBlocks(sample);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'insert');
  assert.deepEqual(blocks[0].rows.map(r => r.id), ['mcp-alpha', 'mcp-beta']);
  assert.equal(blocks[1].kind, 'bare');
  assert.equal(blocks[1].id, 'mcp-gamma');
});

test('findRow locates insert row and bare entry', () => {
  assert.equal(findRow(sample, 'mcp-beta').kind, 'insert-row');
  assert.equal(findRow(sample, 'mcp-gamma').kind, 'bare');
  assert.equal(findRow(sample, 'nope'), undefined);
});

test('removeEntry deletes insert row, keeps others and comments', () => {
  const out = removeEntry(sample, 'mcp-alpha');
  assert.ok(!out.includes('mcp-alpha'));
  assert.ok(out.includes('mcp-beta'));
  assert.ok(out.includes('# keep this comment'));   // 注释必须存活
});

test('removeEntry deletes bare block entirely', () => {
  const out = removeEntry(sample, 'mcp-gamma');
  assert.ok(!out.includes('mcp-gamma'));
  assert.ok(out.includes('mcp-beta'));
});

test('removeEntry removes empty insert block too', () => {
  let out = removeEntry(sample, 'mcp-alpha');
  out = removeEntry(out, 'mcp-beta');
  assert.ok(!out.includes('- insert:'), 'empty insert block should be removed');
  assert.ok(!out.includes('mcp-alpha') && !out.includes('mcp-beta'), 'both rows gone');
  assert.ok(out.includes('mcp-gamma'), 'bare block untouched');
});

test('setDisabled inserts line when absent (insert row)', () => {
  const out = setDisabled(sample, 'mcp-beta', true);
  const row = findRow(out, 'mcp-beta');
  const lines = out.split('\n').slice(row.startLine, row.endLine + 1);
  assert.ok(lines.some(l => /^\s*disabled:\s*true\s*$/.test(l)));
});

test('setDisabled rewrites existing value', () => {
  const out = setDisabled(sample, 'mcp-gamma', false);   // 样本里 gamma 已有 disabled: true
  const row = findRow(out, 'mcp-gamma');
  const lines = out.split('\n').slice(row.startLine, row.endLine + 1);
  assert.ok(lines.some(l => /^\s*disabled:\s*false\s*$/.test(l)));
  assert.ok(!lines.some(l => /disabled:\s*true/.test(l)));
});

test('appendEntry appends top-level bare entry with blank line separator', () => {
  const out = appendEntry(sample, { id: 'mcp-delta', name: '@deepseek-ai/dsh-mcp-client', configLines: ['config:', '  serverName: delta', '  transport: stdio', '  command: npx'] });
  const blocks = parseTopBlocks(out);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[2].id, 'mcp-delta');
  assert.ok(out.includes('serverName: delta'));
});

test('parseTopBlocks ignores indented rows as top-level', () => {
  const out = appendEntry(sample, { id: 'mcp-delta', name: 'x', configLines: [] });
  const blocks = parseTopBlocks(out);
  assert.equal(blocks.filter(b => b.kind === 'insert').length, 1);   // 行内 `    - id:` 不算顶层
});

test('a CRLF patch file parses and edits exactly like an LF one', () => {
  const crlf = sample.replace(/\n/g, '\r\n');
  assert.notEqual(crlf, sample, 'the fixture must actually have been converted');

  const blocks = parseTopBlocks(crlf);
  assert.equal(blocks.length, 2, 'a carriage return must not hide the next top-level block');
  assert.equal(blocks[0].kind, 'insert');
  assert.deepEqual(blocks[0].rows.map(r => r.id), ['mcp-alpha', 'mcp-beta']);
  assert.equal(blocks[1].id, 'mcp-gamma');

  // The same ids the LF fixture resolves must resolve here too.
  assert.equal(findRow(crlf, 'mcp-beta').kind, 'insert-row');
  assert.equal(findRow(crlf, 'mcp-gamma').kind, 'bare');

  // Edits must not leave mixed line endings behind either.
  const removed = removeEntry(crlf, 'mcp-gamma');
  assert.ok(!removed.includes('mcp-gamma'));
  assert.ok(removed.includes('mcp-beta'));
  assert.ok(!removed.includes('\r'), 'output is normalized to LF');

  const toggled = setDisabled(crlf, 'mcp-gamma', false);
  const row = findRow(toggled, 'mcp-gamma');
  const lines = toggled.split('\n').slice(row.startLine, row.endLine + 1);
  assert.ok(lines.some(l => /^\s*disabled:\s*false\s*$/.test(l)));
});

test('a lone CR is treated as a line ending too', () => {
  const cr = sample.replace(/\n/g, '\r');
  const blocks = parseTopBlocks(cr);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].rows.map(r => r.id), ['mcp-alpha', 'mcp-beta']);
  assert.equal(blocks[1].id, 'mcp-gamma');
});

// ---- config subtree: read, replace, and the row-boundary defect that hid behind flow-style args ----

const blocky = readFileSync(path.join(dir, 'fixtures/patch-block-args.yml'), 'utf8');

test('a block-style args sequence does not truncate the row', () => {
  const row = findRow(blocky, 'mcp-blocky');
  const lines = blocky.split('\n').slice(row.startLine, row.endLine + 1);
  assert.ok(lines.some(l => /^\s*- blocky-mcp@1\.0\.0\s*$/.test(l)), 'the nested sequence item must stay inside the row');
  assert.ok(lines.some(l => /serverName: blocky/.test(l)));
});

test('setDisabled keeps a block-style args row intact', () => {
  const out = setDisabled(blocky, 'mcp-blocky', true);
  assert.ok(out.includes('blocky-mcp@1.0.0'), 'args survive the edit');
  assert.ok(out.includes('serverName: next'), 'the following row is untouched');
  assert.ok(/^\s*disabled: true\s*$/m.test(out));
});

test('readConfigBlock returns the dedented subtree and its indent', () => {
  const b = readConfigBlock(sample, 'mcp-alpha');
  assert.equal(b.kind, 'block');
  assert.equal(b.indent, 8);           // insert row: id at 4 -> config at 6 -> subtree at 8
  assert.equal(b.baseIndent, 8);
  assert.equal(b.configText, ["serverName: alpha", "transport: stdio", "command: npx", "args: ['-y', 'alpha-mcp']"].join('\n'));
});

test('readConfigBlock handles bare entries, flow config and absent config', () => {
  assert.equal(readConfigBlock(sample, 'mcp-gamma').kind, 'block');
  assert.equal(readConfigBlock(sample, 'mcp-gamma').indent, 4);
  assert.equal(readConfigBlock(sample, 'nope'), undefined);

  const flow = "- id: mcp-f\n  name: 'x'\n  config: {serverName: f, transport: stdio, command: node}\n";
  const f = readConfigBlock(flow, 'mcp-f');
  assert.equal(f.kind, 'flow');
  assert.equal(f.configText, '{serverName: f, transport: stdio, command: node}');

  const absent = "- id: mcp-a\n  name: 'x'\n";
  assert.equal(readConfigBlock(absent, 'mcp-a').kind, 'absent');
  assert.equal(readConfigBlock(absent, 'mcp-a').indent, 4);
});

test('replaceConfigBlock round-trips byte-for-byte and preserves everything outside', () => {
  const b = readConfigBlock(sample, 'mcp-alpha');
  const out = replaceConfigBlock(sample, 'mcp-alpha', b.configText);
  assert.equal(out, sample, 'an unedited subtree must reproduce the file exactly');
});

test('replaceConfigBlock rewrites only the subtree, keeping id/name/comments', () => {
  // Pasted with a common 2-space indent, as a user would: the common prefix is
  // stripped and the fragment is re-indented to the entry's own depth.
  const fragment = ['  serverName: alpha', '  transport: stdio', '  command: npx', "  args: ['x']"].join('\n');
  const out = replaceConfigBlock(sample, 'mcp-alpha', fragment);
  assert.ok(out.includes('# keep this comment'));
  assert.ok(out.includes('    - id: mcp-alpha'));
  assert.ok(out.includes("      name: '@deepseek-ai/dsh-mcp-client'"));
  assert.ok(out.includes('        serverName: alpha'));
  assert.ok(out.includes('        command: npx'));
  assert.ok(out.includes("        args: ['x']"));
  assert.ok(out.includes('mcp-beta') && out.includes('mcp-gamma'));
});

test('replaceConfigBlock replaces a flow config in place and rejects multi-line input', () => {
  const flow = "- id: mcp-f\n  name: 'x'\n  config: {serverName: f}\n";
  const out = replaceConfigBlock(flow, 'mcp-f', '{serverName: f, transport: stdio, command: node}');
  assert.ok(out.includes('  config: {serverName: f, transport: stdio, command: node}'));
  assert.throws(() => replaceConfigBlock(flow, 'mcp-f', 'a: 1\nb: 2'), /single line/);
});

test('replaceConfigBlock inserts a config line when the entry has none', () => {
  const absent = "- id: mcp-a\n  name: '@deepseek-ai/dsh-mcp-client'\n";
  const out = replaceConfigBlock(absent, 'mcp-a', 'serverName: a\ntransport: stdio\ncommand: node');
  assert.equal(out, [
    '- id: mcp-a',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: a',
    '    transport: stdio',
    '    command: node',
    '',
  ].join('\n'));
});

test('replaceConfigBlock throws for an unknown id', () => {
  assert.throws(() => replaceConfigBlock(sample, 'nope', 'a: 1'), /entry not found: nope/);
});
