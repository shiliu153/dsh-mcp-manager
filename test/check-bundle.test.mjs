import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkBundle } from '../scripts/check-bundle.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('repo root passes bundle compliance', () => {
  const r = checkBundle(root);
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.equal(r.ok, true);
});

test('valid fixture passes', () => {
  const r = checkBundle(path.join(root, 'test/fixtures/bundle-valid'));
  assert.equal(r.ok, true);
});

test('broken fixture fails with locale error', () => {
  const r = checkBundle(path.join(root, 'test/fixtures/bundle-broken'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('locale/en.json')));
});

test('missing dsh.bundle.patch fails', () => {
  const r = checkBundle(path.join(root, 'test/fixtures/bundle-broken'));
  assert.ok(r.errors.some(e => e.includes('dsh.bundle.patch') || e.includes('missing patch file')));
});
