import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

/** Load client.js in a sandbox that captures the module registration. */
function loadModule() {
  let captured;
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } },
    console, fetch: async () => { throw new Error('not used'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, 'client.js must call window.__ModuleLoader__.load');
  return captured;
}

const reactStub = { createElement: (type, props, ...children) => ({ type, props, children }) };
const requireStub = (id) => {
  if (id === 'react') return reactStub;
  throw new Error(`unexpected require: ${id}`);
};

test('module id and inject face are correct', () => {
  const mod = loadModule();
  assert.equal(mod.id, '@dsh-contrib/dsh-mcp-manager');
  const api = mod.factory(requireStub);
  // Spread into a host-realm array: the module's own array has the vm realm's
  // prototype, which deepStrictEqual rejects even when the contents match.
  assert.deepEqual([...api.inject], ['slots', 'locale']);
});

test('apply registers exactly one plugins.detail.section entry', () => {
  const api = loadModule().factory(requireStub);
  const injected = [];
  const registered = [];
  const ctx = {
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (name, cb) => { injected.push(name); registered.push(cb()); },
      register: (descriptor, component) => ({ descriptor, component }),
    },
  };
  api.apply(ctx);
  assert.deepEqual(injected, ['plugins.detail.section']);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].descriptor.name, 'plugins.detail.section');
  assert.equal(registered[0].descriptor.id, 'dsh-mcp-manager');
  assert.equal(typeof registered[0].component, 'function');
});

test('isOurs accepts only this bundle subject', () => {
  const { __test } = loadModule().factory(requireStub);
  assert.equal(__test.isOurs({ kind: 'bundle', pkg: { name: '@dsh-contrib/dsh-mcp-manager' } }), true);
  assert.equal(__test.isOurs({ kind: 'bundle', pkg: { name: '@other/pkg' } }), false);
  assert.equal(__test.isOurs({ kind: 'row', pkg: { name: '@dsh-contrib/dsh-mcp-manager' } }), false);
  assert.equal(__test.isOurs(undefined), false);
});

test('Panel returns null for a subject it does not own, before touching hooks', () => {
  const api = loadModule().factory(requireStub);
  const registered = [];
  const ctx = {
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: { inject: (n, cb) => registered.push(cb()), register: (d, c) => ({ descriptor: d, component: c }) },
  };
  api.apply(ctx);
  const Panel = registered[0].component;
  assert.equal(Panel({ subject: { kind: 'bundle', pkg: { name: '@other/pkg' } } }), null);
});

test('badgeState covers all eight fact combinations', () => {
  const { __test } = loadModule().factory(requireStub);
  const { badgeState } = __test;
  assert.equal(badgeState({ disabled: true, live: true }, true), 'disabled');
  assert.equal(badgeState({ disabled: true, live: false }, true), 'disabled');
  assert.equal(badgeState({ disabled: true, live: true }, false), 'disabled');
  assert.equal(badgeState({ disabled: true, live: false }, false), 'disabled');
  assert.equal(badgeState({ disabled: false, live: true }, true), 'connected');
  assert.equal(badgeState({ disabled: false, live: false }, true), 'enabledOffline');
  assert.equal(badgeState({ disabled: false, live: true }, false), 'unknown');
  assert.equal(badgeState({ disabled: false, live: false }, false), 'unknown');
});

test('commandLine prefers url and joins command with args', () => {
  const { __test } = loadModule().factory(requireStub);
  assert.equal(__test.commandLine({ command: 'npx', args: ['-y', 'pkg'] }), 'npx -y pkg');
  assert.equal(__test.commandLine({ url: 'https://x/mcp' }), 'https://x/mcp');
  assert.equal(__test.commandLine({ command: 'node', args: [] }), 'node');
  assert.equal(__test.commandLine({}), '');
});

test('probeText reports success and failure through the dictionary', () => {
  const { __test } = loadModule().factory(requireStub);
  const t = (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`;
  assert.match(__test.probeText({ toolCount: 29 }, t), /probeOk/);
  assert.match(__test.probeText({ toolCount: 29 }, t), /29/);
  assert.match(__test.probeText({ error: 'boom' }, t), /probeFailed/);
  assert.match(__test.probeText({ error: 'boom' }, t), /boom/);
  assert.equal(__test.probeText(null, t), '');
});

test('errorMessage prefers the server payload over the fallback', () => {
  const { __test } = loadModule().factory(requireStub);
  assert.equal(__test.errorMessage({ error: { message: 'nope' } }, 'fallback'), 'nope');
  assert.equal(__test.errorMessage(null, 'fallback'), 'fallback');
  assert.equal(__test.errorMessage({}, 'fallback'), 'fallback');
});
