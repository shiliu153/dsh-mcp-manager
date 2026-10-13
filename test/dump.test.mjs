import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { loadPatchStructured, loadPatchText } from '../lib/dump.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

test('parses fixture patch into entries', async () => {
  const { entries } = await loadPatchStructured(path.join(dir, 'fixtures/patch-sample.yml'));
  const ids = entries.map(e => e.id);
  assert.ok(ids.includes('mcp-alpha') && ids.includes('mcp-beta') && ids.includes('mcp-gamma'));
  const gamma = entries.find(e => e.id === 'mcp-gamma');
  assert.equal(gamma.disabled, true);
  assert.equal(gamma.config.transport, 'stdio');
});

test('throws on unparsable file', async () => {
  await assert.rejects(() => loadPatchStructured(path.join(dir, 'fixtures/broken.yml')), /./);
});

test('loadPatchText parses text without leaving a temp file behind', async () => {
  const text = readFileSync(path.join(dir, 'fixtures/patch-sample.yml'), 'utf8');
  // A private scratch dir: the test files run in parallel processes, so a
  // shared os.tmpdir() listing would race against the other suite's temp files.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-dump-'));
  const { entries } = await loadPatchText(text, { dir: scratch });
  assert.deepEqual(entries.map((e) => e.id), ['mcp-alpha', 'mcp-beta', 'mcp-gamma']);
  assert.equal(entries[0].config.serverName, 'alpha');
  assert.deepEqual(readdirSync(scratch), [], 'no temp file is left');
});

test('loadPatchText rejects text the official loader cannot parse', async () => {
  await assert.rejects(() => loadPatchText('- insert:\n    - id: x\n   broken: [\n'), /patch parse failed/);
});
