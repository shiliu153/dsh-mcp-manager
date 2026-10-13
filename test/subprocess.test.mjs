import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findOnPath, detectRuntimes } from '../lib/subprocess.js';

test('findOnPath locates a binary that is definitely installed', () => {
  // `node` is running this test, so it is on PATH by construction.
  const p = findOnPath('node');
  assert.ok(p, 'node must be found on PATH');
  assert.match(p, /node(\.exe|\.cmd)?$/i);
});

test('findOnPath returns null for a name that cannot exist', () => {
  assert.equal(findOnPath('definitely-not-a-real-binary-xyzzy-42'), null);
});

test('detectRuntimes reports a boolean for each runtime it gates', () => {
  const r = detectRuntimes();
  assert.deepEqual(Object.keys(r).sort(), ['docker', 'npx', 'uvx']);
  for (const [k, v] of Object.entries(r)) assert.equal(typeof v, 'boolean', k);
  // npx ships with node, which is running this test.
  assert.equal(r.npx, true);
});

test('detectRuntimes caches until refresh is asked for', () => {
  const first = detectRuntimes();
  assert.equal(detectRuntimes(), first, 'the same object is handed back while cached');
  const refreshed = detectRuntimes({ refresh: true });
  assert.notEqual(refreshed, first, 'refresh re-scans into a fresh object');
  assert.equal(detectRuntimes(), refreshed, 'the refreshed object becomes the new cache');
});
