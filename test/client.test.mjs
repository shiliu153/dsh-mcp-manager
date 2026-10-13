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
  return textOf(renderPanelNode(react, subject)).join(' | ');
}

function renderPanelNode(react, subject) {
  const api = loadModule().factory((id) => (id === 'react' ? react : requireStub(id)));
  const registered = [];
  api.apply({
    effect: (fn) => { fn(); },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: { inject: (n, cb) => registered.push(cb()), register: (d, c) => ({ descriptor: d, component: c }) },
  });
  return registered[0].component({ t: (key) => key, subject });
}

/** Collect every className in the rendered tree. */
function classNamesOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) { for (const n of node) classNamesOf(n, out); return out; }
  if (typeof node.props?.className === 'string') out.push(node.props.className);
  if (node.children) classNamesOf(node.children, out);
  return out;
}

/** Find the first element carrying a given className. */
function findByClass(node, className) {
  if (node === null || node === undefined || typeof node === 'boolean') return undefined;
  if (typeof node === 'string' || typeof node === 'number') return undefined;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = findByClass(n, className); if (hit) return hit; }
    return undefined;
  }
  if (node.props?.className === className) return node;
  return node.children ? findByClass(node.children, className) : undefined;
}

// Every custom property client.js references must exist in the host theme. The
// set below was read out of the installed dsh-client-ui-theme bundle. An
// invented name is not an error anywhere: the declaration is simply invalid at
// computed-value time, so the border or colour disappears silently. That is
// exactly how the switch first shipped as a black blob -
// --dsw-alias-border-secondary and --dsw-alias-text-primary do not exist.
const HOST_TOKENS = new Set([
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-brand-primary',
  '--dsw-alias-switch-thumb',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-state-business-primary',
  '--dsw-focus-ring-width',
  '--dsw-focus-ring-color',
]);

test('client.js references only real host theme tokens', () => {
  // Only var() references count: a token named in a comment is prose, not a
  // declaration, and matching those would flag the wildcard notation itself.
  const used = [...new Set([...source.matchAll(/var\(\s*(--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))].sort();
  assert.ok(used.length >= 8, `expected the panel to reference theme tokens, found ${used.length}`);
  const unknown = used.filter((t) => !HOST_TOKENS.has(t));
  assert.deepEqual(unknown, [], `these theme tokens do not exist in the host theme:\n${unknown.join('\n')}`);
});

const READY_ONE = [
  { status: 'ready', data: { patch: '/p', resourcesAvailable: true, servers: [
    { id: 'mcp-a', serverName: 'alpha', transport: 'stdio', command: 'npx', args: ['-y', 'x'], url: '', disabled: false, live: true },
  ] } },
  {}, {}, '', '', null, '',
];

test('the switch copies the host primitive: aria-checked state and a thumb child', () => {
  const node = renderPanelNode(hookReact(READY_ONE), OURS);
  const sw = findByClass(node, 'dsh-mcp-switch');
  assert.ok(sw, 'switch element must render');
  assert.equal(sw.type, 'button');
  assert.equal(sw.props.role, 'switch');
  assert.equal(sw.props['aria-checked'], true, 'an enabled server reads as checked');
  assert.equal(sw.props['data-on'], undefined, 'must not invent a parallel state attribute');
  assert.ok(findByClass(sw.children, 'dsh-mcp-thumb'), 'the track needs its thumb, or it renders as a bare pill');
});

test('a disabled server renders the switch unchecked', () => {
  const node = renderPanelNode(hookReact([
    { status: 'ready', data: { patch: '/p', resourcesAvailable: true, servers: [
      { id: 'mcp-b', serverName: 'beta', transport: 'stdio', command: 'node', args: [], url: '', disabled: true, live: false },
    ] } },
    {}, {}, '', '', null, '',
  ]), OURS);
  assert.equal(findByClass(node, 'dsh-mcp-switch').props['aria-checked'], false);
});

test('the panel renders the classes its stylesheet targets', () => {
  const names = classNamesOf(renderPanelNode(hookReact(READY_ONE), OURS));
  for (const cls of ['dsh-mcp', 'dsh-mcp-row', 'dsh-mcp-badge', 'dsh-mcp-switch', 'dsh-mcp-thumb', 'dsh-mcp-add']) {
    assert.ok(names.includes(cls), `missing ${cls}`);
  }
});

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
