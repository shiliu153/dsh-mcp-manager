import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPatchStructured } from '../lib/dump.js';

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
