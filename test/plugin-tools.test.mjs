import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createToolDefs, name, inject, apply } from '../index.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sample = path.join(dir, 'fixtures/patch-sample.yml');

test('exports official Host form and seven manager tools', () => {
  assert.equal(name, 'dsh-mcp-manager');
  assert.deepEqual(inject, ['tools']);
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  assert.deepEqual(defs.map(d => d.name).sort(), [
    'mcp_manager_add', 'mcp_manager_credential', 'mcp_manager_list',
    'mcp_manager_probe', 'mcp_manager_remove', 'mcp_manager_toggle', 'mcp_manager_validate',
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
  assert.equal(registered.length, 5, `expected the five panel routes, got ${registered.length}`);
  assert.ok(registered.every((r) => r.path.startsWith('/api/dsh-mcp-manager/')));
  assert.ok(registered.some((r) => r.path.endsWith('/servers') && r.methods.includes('GET')));
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
