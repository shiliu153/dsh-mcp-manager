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

// Stand-ins for the two host primitives the panel uses. Each call is recorded
// so a test can assert on the props the panel passed, not just on the tree
// shape: the primitive's own appearance is the thing under test here.
function primitivesStub(log) {
  return {
    StateDot: (props) => {
      log.push({ kind: 'StateDot', props });
      return { type: 'StateDot', props, children: [] };
    },
    Tooltip: (props) => {
      log.push({ kind: 'Tooltip', props });
      return { type: 'Tooltip', props, children: props.children };
    },
  };
}

// `primitives === 'throw'` reproduces a host that does not seed
// @deepseek-ai/dsh-client-ui-primitives, which is the degraded path.
function makeRequire(react, primitives) {
  return (id) => {
    if (id === 'react') return react;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives === 'throw') throw new Error('primitives unavailable');
      return primitives;
    }
    throw new Error(`unexpected require: ${id}`);
  };
}

const requireStub = makeRequire(reactStub, primitivesStub([]));

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

test('badgeKey maps every state to a dictionary key and falls back to unknown', () => {
  const { __test } = loadModule().factory(requireStub);
  const { badgeKey } = __test;
  assert.equal(badgeKey('connected'), 'badgeConnected');
  assert.equal(badgeKey('enabledOffline'), 'badgeEnabledOffline');
  assert.equal(badgeKey('disabled'), 'badgeDisabled');
  assert.equal(badgeKey('unknown'), 'badgeUnknown');
  assert.equal(badgeKey('nonsense'), 'badgeUnknown', 'an unmapped state must not render an undefined label');
  assert.equal(badgeKey(undefined), 'badgeUnknown');
});

test('dotProps maps every state to a StateDot state, with a hollow ring for unknown', () => {
  const { __test } = loadModule().factory(requireStub);
  const { dotProps } = __test;
  // Spread into host-realm objects: the module's own objects carry the vm
  // realm's prototype, which deepStrictEqual rejects even when the contents
  // match (same reason the inject face is spread above).
  assert.deepEqual({ ...dotProps('connected') }, { state: 'done' });
  assert.deepEqual({ ...dotProps('enabledOffline') }, { state: 'warning' });
  assert.deepEqual({ ...dotProps('disabled') }, { state: 'idle' });
  // unknown keeps the idle colour but switches to the primitive's hollow step
  // ring, so "the registry is unreadable" never looks like "disabled".
  assert.deepEqual({ ...dotProps('unknown') }, { state: 'idle', appearance: 'step' });
  assert.deepEqual({ ...dotProps('nonsense') }, { state: 'idle', appearance: 'step' });
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

function renderPanel(react, subject, primitives) {
  return textOf(renderPanelNode(react, subject, primitives)).join(' | ');
}

function renderPanelNode(react, subject, primitives = primitivesStub([])) {
  const api = loadModule().factory(makeRequire(react, primitives));
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

/** Find the first element carrying a given prop value. */
function findByProp(node, key, value) {
  if (node === null || node === undefined || typeof node === 'boolean') return undefined;
  if (typeof node === 'string' || typeof node === 'number') return undefined;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = findByProp(n, key, value); if (hit) return hit; }
    return undefined;
  }
  if (node.props?.[key] === value) return node;
  return node.children ? findByProp(node.children, key, value) : undefined;
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
  // The status dot's own colours. The primitive carries them in normal
  // operation, but the degraded dot below paints with the same vocabulary.
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-label-tertiary',
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
  for (const cls of ['dsh-mcp', 'dsh-mcp-row', 'dsh-mcp-dot-anchor', 'dsh-mcp-switch', 'dsh-mcp-thumb', 'dsh-mcp-add']) {
    assert.ok(names.includes(cls), `missing ${cls}`);
  }
});

const OURS = { kind: 'bundle', pkg: { name: '@dsh-contrib/dsh-mcp-manager' } };

test('the ready path renders rows and targets', () => {
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
  assert.match(text, /mcp-b/);
  assert.match(text, /\/tmp\/p\.yml/);
});

test('each row renders a status dot whose state follows the server facts', () => {
  const log = [];
  const react = hookReact([
    { status: 'ready', data: { patch: '/p', resourcesAvailable: true, servers: [
      { id: 'mcp-a', serverName: 'alpha', transport: 'stdio', command: 'npx', args: ['-y', 'x'], url: '', disabled: false, live: true },
      { id: 'mcp-b', serverName: 'beta', transport: 'stdio', command: 'node', args: [], url: '', disabled: false, live: false },
      { id: 'mcp-c', serverName: 'gamma', transport: 'stdio', command: 'node', args: [], url: '', disabled: true, live: false },
    ] } },
    {}, {}, '', '', null, '',
  ]);
  renderPanelNode(react, OURS, primitivesStub(log));
  const dots = log.filter((e) => e.kind === 'StateDot').map((e) => e.props);
  assert.equal(dots.length, 3);
  assert.deepEqual(dots.map((p) => p.state), ['done', 'warning', 'idle']);
  assert.deepEqual(dots.map((p) => p.appearance), [undefined, undefined, undefined],
    'only the unavailable reading is a hollow ring');
});

test('a server whose live state cannot be read renders the hollow ring', () => {
  const log = [];
  const react = hookReact([
    { status: 'ready', data: { patch: '/p', resourcesAvailable: false, servers: [
      { id: 'mcp-d', serverName: 'delta', transport: 'stdio', command: 'node', args: [], url: '', disabled: false, live: false },
    ] } },
    {}, {}, '', '', null, '',
  ]);
  renderPanelNode(react, OURS, primitivesStub(log));
  const dot = log.find((e) => e.kind === 'StateDot');
  assert.equal(dot.props.state, 'idle');
  assert.equal(dot.props.appearance, 'step');
});

test('the status dot is anchored in the host Tooltip, on a real DOM element', () => {
  const log = [];
  const react = hookReact(READY_ONE);
  const node = renderPanelNode(react, OURS, primitivesStub(log));

  const tooltips = log.filter((e) => e.kind === 'Tooltip');
  assert.equal(tooltips.length, 1);
  assert.equal(tooltips[0].props.label, 'badgeConnected');
  assert.equal(tooltips[0].props.side, 'top');

  // Tooltip positions its bubble from a ref on its child. StateDot is a plain
  // function component with no forwardRef, so a bare StateDot child would
  // receive a ref it cannot forward and the bubble would never appear.
  const anchor = findByClass(node, 'dsh-mcp-dot-anchor');
  assert.ok(anchor, 'the tooltip anchor must exist');
  assert.equal(anchor.type, 'span');
  assert.equal(anchor.props.role, 'img');
  assert.equal(anchor.props['aria-label'], 'badgeConnected');
  assert.equal(anchor.props.title, undefined,
    'a native title beside the host bubble would show two tooltips');
  assert.ok(anchor.children.some((c) => c?.type === 'StateDot'),
    'the primitive must stay a child of the anchor');
});

test('without the host primitives the panel degrades to a self-drawn dot and a native title', () => {
  const react = hookReact(READY_ONE);
  const node = renderPanelNode(react, OURS, 'throw');

  const anchor = findByClass(node, 'dsh-mcp-dot-anchor');
  assert.ok(anchor, 'the row must still render a dot when the primitive is missing');
  assert.equal(anchor.props.title, 'badgeConnected');

  const dot = findByClass(node, 'dsh-mcp-dot');
  assert.ok(dot, 'the fallback dot must render');
  assert.equal(dot.props['data-state'], 'connected');
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

test('the header offers one-click probing of every registered server', () => {
  const react = hookReact([
    { status: 'ready', data: { patch: '/p', resourcesAvailable: true, servers: [
      { id: 'mcp-a', serverName: 'alpha', transport: 'stdio', command: 'npx', args: ['-y', 'x'], url: '', disabled: false, live: true },
      { id: 'mcp-b', serverName: 'beta', transport: 'stdio', command: 'node', args: [], url: '', disabled: false, live: false },
    ] } },
    {}, {}, '', '', null, '',
  ]);
  const node = renderPanelNode(react, OURS, primitivesStub([]));
  const button = findByProp(node, 'title', 'probeAllLabel');
  assert.ok(button, 'the header must offer a probe-all control');
  assert.equal(button.type, 'button');
  assert.equal(button.props.disabled, false);
  assert.equal(textOf(button).join(''), 'probeAll');
});

test('probe-all is not offered when there is nothing to probe', () => {
  const react = hookReact([
    { status: 'ready', data: { patch: '/p', resourcesAvailable: true, servers: [] } },
    {}, {}, '', '', null, '',
  ]);
  const node = renderPanelNode(react, OURS, primitivesStub([]));
  assert.equal(findByProp(node, 'title', 'probeAllLabel'), undefined);
});

test('probe-all is not offered while the list is still loading', () => {
  const react = hookReact([{ status: 'loading' }, {}, {}, '', '', null, '']);
  const node = renderPanelNode(react, OURS, primitivesStub([]));
  assert.equal(findByProp(node, 'title', 'probeAllLabel'), undefined);
});
