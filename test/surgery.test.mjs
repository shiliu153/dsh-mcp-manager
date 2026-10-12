import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTopBlocks, findRow, removeEntry, setDisabled, appendEntry } from '../lib/surgery.js';

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
