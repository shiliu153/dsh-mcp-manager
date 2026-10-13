import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBundle } from '../scripts/check-bundle.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Copy a fixture into a temp dir so tests never mutate checked-in files. */
function tempBundle(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
  fs.cpSync(path.join(root, 'test/fixtures', fixture), dir, { recursive: true });
  return dir;
}

function patchManifest(dir, mutate) {
  const p = path.join(dir, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
  mutate(manifest);
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
}

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

test('declaring dsh.client without exports["./client"] fails', () => {
  const dir = tempBundle('bundle-broken');
  patchManifest(dir, (m) => { m.dsh = { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }; });
  const r = checkBundle(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('exports["./client"]')), JSON.stringify(r.errors));
});

test('a declared client file must exist and be shipped in the files allowlist', () => {
  const dir = tempBundle('bundle-valid');
  fs.writeFileSync(path.join(dir, 'client.js'), '// browser half\n');
  patchManifest(dir, (m) => {
    m.exports['./client'] = './client.js';
    m.dsh.client = { platform: 'web' };
  });

  const stripped = checkBundle(dir);
  assert.equal(stripped.ok, false);
  assert.ok(stripped.errors.some((e) => e.includes('client file')), JSON.stringify(stripped.errors));

  patchManifest(dir, (m) => { m.files.push('client.js'); });
  const shipped = checkBundle(dir);
  assert.deepEqual(shipped.errors, [], JSON.stringify(shipped.errors));

  fs.rmSync(path.join(dir, 'client.js'));
  const gone = checkBundle(dir);
  assert.equal(gone.ok, false);
  assert.ok(gone.errors.some((e) => e.includes('missing client file')), JSON.stringify(gone.errors));
});
