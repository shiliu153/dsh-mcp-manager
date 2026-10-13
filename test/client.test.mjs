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

// ---- render smoke test -------------------------------------------------------
// A tiny React stand-in: createElement invokes function components (so the
// panel's own tree is walked for real), and useState hands back a scripted
// sequence of state values in call order.

function hookReact(states) {
  let i = 0;
  const createElement = (type, props, ...children) => {
    if (typeof type === 'function') return type({ ...(props ?? {}), children });
    return { type, props, children };
  };
  return {
    createElement,
    useState: () => [states[i++], () => {}],
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
}

function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out; }
  if (node.children) textOf(node.children, out);
  return out;
}

function renderPanel(react, subject) {
  const api = loadModule().factory((id) => (id === 'react' ? react : requireStub(id)));
  const registered = [];
  api.apply({
    effect: (fn) => { fn(); },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: { inject: (n, cb) => registered.push(cb()), register: (d, c) => ({ descriptor: d, component: c }) },
  });
  return textOf(registered[0].component({ t: (key) => key, subject })).join(' | ');
}

const OURS = { kind: 'bundle', pkg: { name: '@dsh-contrib/dsh-mcp-manager' } };

test('the ready path renders rows, targets and badges', () => {
  const react = hookReact([
    { status: 'ready', data: { patch: '/tmp/p.yml', resourcesAvailable: true, servers: [
      { id: 'mcp-a', serverName: 'alpha', transport: 'stdio', command: 'npx', args: ['-y', 'x'], url: '', disabled: false, live: true },
      { id: 'mcp-b', serverName: 'beta', transport: 'stdio', command: 'node', args: [], url: '', disabled: true, live: false },
    ] } },
    {}, {}, '', '', null, '',
  ]);
  const text = renderPanel(react, OURS);
  assert.match(text, /mcp-a/);
  assert.match(text, /npx -y x/);
  assert.match(text, /badgeConnected/);
  assert.match(text, /mcp-b/);
  assert.match(text, /badgeDisabled/);
  assert.match(text, /\/tmp\/p\.yml/);
});

test('an enabled but unregistered server renders the blind-spot badge', () => {
  const react = hookReact([
    { status: 'ready', data: { patch: '/p', resourcesAvailable: true, servers: [
      { id: 'mcp-c', serverName: 'gamma', transport: 'stdio', command: 'node', args: [], url: '', disabled: false, live: false },
    ] } },
    {}, {}, '', '', null, '',
  ]);
  assert.match(renderPanel(react, OURS), /badgeEnabledOffline/);
});

test('a missing resource service renders the unavailable badge', () => {
  const react = hookReact([
    { status: 'ready', data: { patch: '/p', resourcesAvailable: false, servers: [
      { id: 'mcp-d', serverName: 'delta', transport: 'stdio', command: 'node', args: [], url: '', disabled: false, live: false },
    ] } },
    {}, {}, '', '', null, '',
  ]);
  assert.match(renderPanel(react, OURS), /badgeUnknown/);
});

test('the error path renders the message and a retry control', () => {
  const react = hookReact([{ status: 'error', message: 'boom' }, {}, {}, '', '', null, '']);
  const text = renderPanel(react, OURS);
  assert.match(text, /boom/);
  assert.match(text, /retry/);
});

test('the empty list says so instead of rendering nothing', () => {
  const react = hookReact([
    { status: 'ready', data: { patch: '/p', resourcesAvailable: true, servers: [] } },
    {}, {}, '', '', null, '',
  ]);
  assert.match(renderPanel(react, OURS), /empty/);
});
