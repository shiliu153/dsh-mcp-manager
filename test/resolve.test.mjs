import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInput, deriveServerName } from '../lib/resolve.js';

test('npm package name -> stdio npx entry', async () => {
  const { entry } = await resolveInput('@modelcontextprotocol/server-everything');
  assert.equal(entry.config.transport, 'stdio');
  assert.deepEqual(entry.config.args, ['-y', '@modelcontextprotocol/server-everything']);
  assert.equal(entry.config.serverName, 'everything');
  assert.equal(entry.name, '@deepseek-ai/dsh-mcp-client');
});

test('deriveServerName strips scope and -mcp/-server suffix, clamps to charset', () => {
  assert.equal(deriveServerName('@scope/my-mcp-server'), 'my');
  assert.equal(deriveServerName('foo-bar-mcp'), 'foo-bar');
  assert.equal(deriveServerName('@scope/' + 'n'.repeat(40)), 'n'.repeat(32));
});

test('http url -> streamable-http entry', async () => {
  const { entry } = await resolveInput('https://api.example.com/mcp');
  assert.equal(entry.config.transport, 'streamable-http');
  assert.equal(entry.config.url, 'https://api.example.com/mcp');
  assert.ok(SERVER_NAME_SAFE.test(entry.config.serverName));
});

const SERVER_NAME_SAFE = /^[A-Za-z0-9_-]{1,32}$/;

test('json fragment (claude format) maps fields', async () => {
  const { entry } = await resolveInput('{"mcpServers":{"fs":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}}');
  assert.equal(entry.config.transport, 'stdio');
  assert.equal(entry.config.serverName, 'fs');
  assert.deepEqual(entry.config.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
});

test('github repo with package.json -> stdio via npm name', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('/package.json')) return { ok: true, json: async () => ({ name: 'some-mcp', bin: { 'some-mcp': 'cli.js' } }) };
    throw new Error('unexpected ' + url);
  };
  const { entry, notes } = await resolveInput('https://github.com/owner/some-repo', { fetchFn });
  assert.equal(entry.config.transport, 'stdio');
  assert.equal(entry.config.command, 'npx');
  assert.ok(notes.some(n => n.includes('some-mcp')));
});

test('github repo unreachable -> template with needsInput', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  const r = await resolveInput('https://github.com/owner/whatever', { fetchFn });
  assert.equal(r.entry, null);
  assert.ok(r.needsInput.length > 0);
});

test('json with secret-named env value passes through (no pseudo-warning)', async () => {
  const { entry, warnings } = await resolveInput('{"mcpServers":{"x":{"command":"npx","env":{"DEBUG":"1"}}}}');
  assert.equal(entry.config.env.DEBUG, '1');
  assert.ok(!warnings.some(w => w.includes('scrubbed')));
});

test('unrecognized input throws', async () => {
  await assert.rejects(() => resolveInput('not a package or url!!'), /unrecognized/i);
});
