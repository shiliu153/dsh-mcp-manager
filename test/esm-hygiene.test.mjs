// Host-side sources are ES modules: `require` does not exist in them.
//
// WHY THIS TEST EXISTS: lib/dump.js called `require('node:path')` on the branch
// taken only when IS_ELECTRON is true - i.e. exactly when running INSIDE the
// harness. Under plain node the branch is never taken, so the CLI, every unit
// test and every hand-run check passed while every host tool that reads the
// patch file failed in the real app with "require is not defined". The failure
// was invisible until the browser panel exercised the route in-harness.
//
// Scope: lib/**/*.js and index.js. client.js is excluded because its `require`
// is the browser module loader's own parameter, and cli/mcp.js because its only
// occurrence is inside the usage text (a `!!js` example), not code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function hostSources() {
  const files = [path.join(root, 'index.js')];
  for (const f of fs.readdirSync(path.join(root, 'lib'))) {
    if (f.endsWith('.js')) files.push(path.join(root, 'lib', f));
  }
  return files;
}

test('host-side ESM sources contain no CommonJS require()', () => {
  const offenders = [];
  for (const file of hostSources()) {
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/\brequire\s*\(/.test(line)) offenders.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `host sources must not call require():\n${offenders.join('\n')}`);
});

test('lib/dump.js resolves the asar path without require', () => {
  const text = fs.readFileSync(path.join(root, 'lib/dump.js'), 'utf8');
  assert.match(text, /import path from 'node:path'/, 'must import node:path as an ESM binding');
  assert.match(text, /path\.join\(path\.dirname\(HARNESS_EXE\)/, 'must derive the asar dir from the harness exe');
});
