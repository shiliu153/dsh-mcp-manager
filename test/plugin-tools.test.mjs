import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolDefs, name, inject, apply } from '../index.js';
import { findRow } from '../lib/surgery.js';
import { loadPatchText } from '../lib/dump.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sample = path.join(dir, 'fixtures/patch-sample.yml');

test('exports official Host form and nine manager tools', () => {
  assert.equal(name, 'dsh-mcp-manager');
  assert.deepEqual(inject, ['tools']);
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  assert.deepEqual(defs.map(d => d.name).sort(), [
    'mcp_manager_add', 'mcp_manager_credential', 'mcp_manager_list',
    'mcp_manager_probe', 'mcp_manager_remove', 'mcp_manager_search',
    'mcp_manager_toggle', 'mcp_manager_update', 'mcp_manager_validate',
  ]);
  for (const d of defs) {
    assert.equal(typeof d.execute, 'function');
    assert.ok(d.parameters && typeof d.parameters === 'object' && d.parameters.type === 'object');
    assert.equal(typeof d.output.render, 'function');
    const rendered = d.output.render({}, { text: 'x' });
    assert.deepEqual(rendered, [{ type: 'text', text: 'x' }]);
  }
});

test('list tool executes against a fixture file', async () => {
  const defs = createToolDefs(sample);
  const list = defs.find(d => d.name === 'mcp_manager_list');
  const out = await list.execute({}, { signal: new AbortController().signal });
  assert.ok(out.text.includes('mcp-alpha'));
  assert.ok(out.text.includes('stdio'));
  assert.ok(!out.text.includes('gamma-token.txt'), 'credential masked');
});

test('toggle tool requires explicit confirm', async () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const toggle = defs.find(d => d.name === 'mcp_manager_toggle');
  const out = await toggle.execute({ id: 'x', disabled: true }, { signal: new AbortController().signal });
  assert.ok(out.text.includes('confirm'), 'must ask for confirm');
});

test('remove tool requires explicit confirm', async () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const remove = defs.find(d => d.name === 'mcp_manager_remove');
  const out = await remove.execute({ id: 'x' }, { signal: new AbortController().signal });
  assert.ok(out.text.includes('confirm'));
});

test('add tool dry-run returns entry without writing', async () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const add = defs.find(d => d.name === 'mcp_manager_add');
  const out = await add.execute({ input: '@modelcontextprotocol/server-everything' }, { signal: new AbortController().signal });
  assert.ok(out.text.includes('stdio'));
  assert.ok(out.text.includes('DRY RUN'));
});

test('execute captures thrown errors as ERROR text, never rejects', async () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const list = defs.find(d => d.name === 'mcp_manager_list');
  const out = await list.execute({}, { signal: new AbortController().signal });
  assert.ok(out.text.startsWith('ERROR:'));
});

test('apply registers Fetch routes when a connection service is present', () => {
  const registered = [];
  const ctx = {
    tools: { register: () => () => {} },
    effect: (fn) => { fn(); return () => {}; },
    inject: (services, cb) => {
      assert.deepEqual(services, ['connection']);
      cb({ connection: { registerFetchRoute: (owner, route) => { registered.push(route); return () => {}; } } });
    },
  };
  apply(ctx);
  assert.equal(registered.length, 8, `expected the eight panel routes, got ${registered.length}`);
  assert.ok(registered.every((r) => r.path.startsWith('/api/dsh-mcp-manager/')));
  assert.ok(registered.some((r) => r.path.endsWith('/servers') && r.methods.includes('GET')));
  assert.ok(registered.some((r) => r.path.endsWith('/update') && r.methods.includes('POST')));
  assert.ok(registered.some((r) => r.path.endsWith('/market') && r.methods.includes('GET')));
  assert.ok(registered.some((r) => r.path.endsWith('/market/install') && r.methods.includes('POST')));
  assert.ok(registered.every((r) => r.path.startsWith('/api/')), 'every path must sit under /api');
});

test('apply stays inert without a connection service', () => {
  const ctx = {
    tools: { register: () => () => {} },
    effect: () => () => {},
    inject: () => { /* service absent: the callback never runs */ },
  };
  assert.doesNotThrow(() => apply(ctx));
});

function tmpPatch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-'));
  const f = path.join(d, 'cordis.patch.yml');
  fs.copyFileSync(sample, f);
  return f;
}

// Real probing spawns a process, so the write path injects the same stub the
// route tests use: createToolDefs takes the probe as a seam for exactly this.
const stubProbe = async () => ({ ok: true, toolCount: 3, tools: ['a', 'b', 'c'] });

test('mcp_manager_update dry-runs, reports introduced expressions, then writes', async () => {
  const file = tmpPatch();
  const update = createToolDefs(file, { probe: stubProbe }).find((d) => d.name === 'mcp_manager_update');
  assert.ok(update, 'the update tool must be registered');
  const exec = { signal: new AbortController().signal };

  const dry = await update.execute({ id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio\ncommand: node' }, exec);
  assert.match(dry.text, /DRY RUN/);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('toolCallTimeoutMs'));

  const js = await update.execute({ id: 'mcp-gamma', config: "serverName: gamma\ntransport: stdio\ncommand: node\nenv:\n  X: !!js process.env.HOME" }, exec);
  assert.match(js.text, /adds 1 new !!js expression/);

  const bad = await update.execute({ id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio' }, exec);
  assert.match(bad.text, /FAIL rules_failed/);

  const ok = await update.execute({ id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio\ncommand: node\ntoolCallTimeoutMs: 90000', confirm: true }, exec);
  assert.match(ok.text, /updated mcp-gamma/);
  assert.match(ok.text, /probe OK: 3 tools/);
  assert.ok(fs.readFileSync(file, 'utf8').includes('toolCallTimeoutMs: 90000'));
});

test('mcp_manager_update keeps the row\'s !!js expression when fed a placeholder', async () => {
  const file = tmpPatch();
  const defs = createToolDefs(file, { probe: stubProbe });
  const { toPanelView } = await import('../lib/update.js');
  const { readConfigBlock } = await import('../lib/surgery.js');
  const view = toPanelView(readConfigBlock(fs.readFileSync(file, 'utf8'), 'mcp-gamma').configText);

  const out = await defs.find((d) => d.name === 'mcp_manager_update')
    .execute({ id: 'mcp-gamma', config: view.configText, confirm: true }, { signal: new AbortController().signal });
  assert.match(out.text, /updated mcp-gamma/);
  assert.ok(fs.readFileSync(file, 'utf8').includes("GAMMA_TOKEN: !!js require('fs')"), 'the expression came back verbatim');
});

// The add path used to probe the in-memory entry it had just built, so it
// reported `probe OK` while the file held a flat, unmountable row. The probe
// must see what the file actually holds.
test('mcp_manager_add probes the persisted row, not the in-memory entry', async () => {
  const file = tmpPatch();
  const seen = [];
  const probe = async (config) => { seen.push(config); return { ok: true, toolCount: 2, tools: [] }; };
  const add = createToolDefs(file, { probe }).find((d) => d.name === 'mcp_manager_add');

  const out = await add.execute({ input: '@upstash/context7-mcp', confirm: true }, { signal: new AbortController().signal });
  assert.match(out.text, /written/);

  const text = fs.readFileSync(file, 'utf8');
  assert.equal(findRow(text, 'mcp-context7').kind, 'insert-row', 'the loader only mounts insert rows');
  const { entries } = await loadPatchText(text);
  const persisted = entries.find((e) => e.id === 'mcp-context7');
  assert.ok(persisted, 'the written entry must be readable back');

  assert.equal(seen.length, 1, 'the write path probes exactly once');
  assert.deepEqual(seen[0], persisted.config, 'the probe must see the persisted config');
  assert.equal(seen[0].serverName, 'context7');
});

// The update path has always refused a duplicate serverName; the add path did
// not, so adding a server twice produced two rows the loader rejects as a pair.
test('mcp_manager_add refuses a serverName that is already registered', async () => {
  const file = tmpPatch();
  const before = fs.readFileSync(file, 'utf8');
  const add = createToolDefs(file, { probe: stubProbe }).find((d) => d.name === 'mcp_manager_add');

  const out = await add.execute({ input: 'alpha-mcp', confirm: true }, { signal: new AbortController().signal });
  assert.match(out.text, /duplicate serverName: alpha/, out.text);
  assert.ok(!out.text.includes('candidate failed validation'), 'the reason alone, not the pipeline internals');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the live file must be untouched');
});

// ---- market tool -------------------------------------------------------------

const REGISTRY_ENTRY = {
  server: {
    name: 'ai.ankimcp/anki-mcp-server',
    title: 'Anki MCP Server',
    description: 'MCP server for Anki flashcards.',
    version: '0.27.0',
    packages: [{ registryType: 'npm', identifier: '@ankimcp/anki-mcp-server', version: '0.27.0', transport: { type: 'stdio' } }],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: 'P', updatedAt: 'U', isLatest: true } },
};

const stubSearch = (servers, extra = {}) => async () => ({ servers, nextCursor: undefined, fetchedAt: 0, fromCache: false, ...extra });
const stubGet = (server, extra = {}) => async () => ({ server, fromCache: false, ...extra });
const toolNamed = (file, toolName, opts = {}) =>
  createToolDefs(file, { probe: stubProbe, ...opts }).find((d) => d.name === toolName);
// tmpPatch() makes a fresh mkdtemp directory per call; drop the whole directory.
const dropPatch = (file) => fs.rmSync(path.dirname(file), { recursive: true, force: true });

test('mcp_manager_search is read-only and lists the execution surface', async () => {
  const file = tmpPatch();
  try {
    const before = fs.readFileSync(file, 'utf8');
    const tool = toolNamed(file, 'mcp_manager_search', { search: stubSearch([REGISTRY_ENTRY]) });
    const out = await tool.execute({ query: 'anki' }, {});
    assert.match(out.text, /ai\.ankimcp\/anki-mcp-server@0\.27\.0/);
    assert.match(out.text, /npx -y @ankimcp\/anki-mcp-server@0\.27\.0/);
    assert.match(out.text, /serverName: anki-mcp-server/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'search must not write');
  } finally { dropPatch(file); }
});

test('mcp_manager_search reports an unreachable registry as text, not a throw', async () => {
  const file = tmpPatch();
  try {
    const tool = toolNamed(file, 'mcp_manager_search', { search: stubSearch([], { degraded: 'HTTP 503' }) });
    const out = await tool.execute({ query: 'x' }, {});
    assert.match(out.text, /registry unreachable: HTTP 503/);
  } finally { dropPatch(file); }
});

test('mcp_manager_search says so when every hit was filtered out', async () => {
  const file = tmpPatch();
  try {
    const sse = { server: { name: 'ai.x/sse', version: '1.0.0', description: 'd', remotes: [{ type: 'sse', url: 'https://x/sse' }] }, _meta: {} };
    const tool = toolNamed(file, 'mcp_manager_search', { search: stubSearch([sse]) });
    const out = await tool.execute({ query: 'x' }, {});
    assert.match(out.text, /no installable registry entries/);
  } finally { dropPatch(file); }
});

test('mcp_manager_search names the credentials still to be filled', async () => {
  const file = tmpPatch();
  try {
    const needsKey = {
      server: {
        name: 'ai.x/needs-key', version: '1.0.0', description: 'd',
        packages: [{ registryType: 'npm', identifier: 'needs-key', version: '1.0.0', transport: { type: 'stdio' }, environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }] }],
      },
      _meta: {},
    };
    const tool = toolNamed(file, 'mcp_manager_search', { search: stubSearch([needsKey]) });
    const out = await tool.execute({ query: 'key' }, {});
    assert.match(out.text, /needs credentials: API_KEY/);
  } finally { dropPatch(file); }
});

test('mcp_manager_search flags a server that is already registered', async () => {
  const file = tmpPatch();
  try {
    const tool = toolNamed(file, 'mcp_manager_search', { search: stubSearch([{
      server: { name: 'ai.x/alpha', version: '2.0.0', description: 'd', packages: [{ registryType: 'npm', identifier: 'alpha-mcp', version: '2.0.0', transport: { type: 'stdio' } }] },
      _meta: {},
    }]) });
    const out = await tool.execute({ query: 'alpha' }, {});
    assert.match(out.text, /installed as mcp-alpha/);
    // The fixture's alpha row pins nothing, so the drift must say so rather than
    // claim it is up to date.
    assert.match(out.text, /cannot be compared/);
  } finally { dropPatch(file); }
});

test('mcp_manager_add with source=registry dry-runs, then writes the mapped row', async () => {
  const file = tmpPatch();
  try {
    const add = toolNamed(file, 'mcp_manager_add', { get: stubGet(REGISTRY_ENTRY.server) });
    const dry = await add.execute({ input: 'ai.ankimcp/anki-mcp-server', source: 'registry' }, {});
    assert.match(dry.text, /DRY RUN/);
    assert.match(dry.text, /anki-mcp-server@0\.27\.0/);
    assert.ok(!fs.readFileSync(file, 'utf8').includes('anki-mcp-server'), 'dry run writes nothing');

    const written = await add.execute({ input: 'ai.ankimcp/anki-mcp-server', source: 'registry', confirm: true }, {});
    assert.match(written.text, /written/);
    assert.match(written.text, /probe OK: 3 tools/);
    assert.equal(findRow(fs.readFileSync(file, 'utf8'), 'mcp-anki-mcp-server').kind, 'insert-row');
  } finally { dropPatch(file); }
});

test('mcp_manager_add with source=registry surfaces the credential gap as a warning', async () => {
  const file = tmpPatch();
  try {
    const needsKey = {
      name: 'ai.x/needs-key', version: '1.0.0', description: 'd',
      packages: [{ registryType: 'npm', identifier: 'needs-key', version: '1.0.0', transport: { type: 'stdio' }, environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }] }],
    };
    const add = toolNamed(file, 'mcp_manager_add', { get: stubGet(needsKey) });
    const dry = await add.execute({ input: 'ai.x/needs-key', source: 'registry' }, {});
    assert.match(dry.text, /warn: needs secret API_KEY/);
  } finally { dropPatch(file); }
});

test('mcp_manager_add with source=registry refuses an unknown entry', async () => {
  const file = tmpPatch();
  try {
    const add = toolNamed(file, 'mcp_manager_add', { get: async () => ({ server: undefined, error: 'HTTP 404', fromCache: false }) });
    const out = await add.execute({ input: 'ai.x/nope', source: 'registry' }, {});
    assert.match(out.text, /^ERROR: HTTP 404/);
  } finally { dropPatch(file); }
});

test('mcp_manager_add with source=registry refuses an uninstallable entry', async () => {
  const file = tmpPatch();
  try {
    const sse = { name: 'ai.x/sse', version: '1.0.0', description: 'd', remotes: [{ type: 'sse', url: 'https://x/sse' }] };
    const add = toolNamed(file, 'mcp_manager_add', { get: stubGet(sse) });
    const out = await add.execute({ input: 'ai.x/sse', source: 'registry' }, {});
    assert.match(out.text, /^ERROR: not installable: sse/);
  } finally { dropPatch(file); }
});

test('mcp_manager_add with source=auto is unchanged', async () => {
  const file = tmpPatch();
  try {
    const add = toolNamed(file, 'mcp_manager_add', {});
    const out = await add.execute({ input: '@upstash/context7-mcp' }, {});
    assert.match(out.text, /DRY RUN/);
    assert.match(out.text, /npx/);
  } finally { dropPatch(file); }
});
