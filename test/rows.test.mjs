import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMcpClientRow, maskEntry } from '../lib/rows.js';

test('isMcpClientRow keeps MCP client rows and drops unrelated ones', () => {
  assert.equal(isMcpClientRow({ id: 'a', name: '@deepseek-ai/dsh-mcp-client', config: {} }), true);
  assert.equal(isMcpClientRow({ id: 'b', name: '', config: {} }), true, 'row with no name');
  assert.equal(isMcpClientRow({ id: 'c', config: { transport: 'stdio' } }), true, 'row with transport');
  assert.equal(isMcpClientRow({ id: 'd', name: '@deepseek-ai/dsh-hooks-claude-code', config: { configPath: 'x' } }), false);
});

test('maskEntry masks secret-named keys', () => {
  const entry = {
    id: 'mcp-github',
    name: '@deepseek-ai/dsh-mcp-client',
    config: { serverName: 'github', transport: 'streamable-http', url: 'https://x/mcp',
      headers: { Authorization: 'Bearer sk-real-secret', 'X-Trace': 'keep-me' } },
  };
  const masked = maskEntry(entry);
  assert.equal(masked.config.headers.Authorization, 'B*****');
  assert.equal(masked.config.headers['X-Trace'], 'keep-me', 'non-secret header untouched');
  assert.equal(entry.config.headers.Authorization, 'Bearer sk-real-secret', 'original not mutated');
});

test('maskEntry masks !!js expression markers even when the key looks innocent', () => {
  const entry = { id: 'x', config: { env: { SOMETHING: { __jsExpr: "readFileSync('f','utf8')" } } } };
  assert.equal(maskEntry(entry).config.env.SOMETHING, 'B*****');
});

test('maskEntry tolerates rows without env/headers', () => {
  assert.deepEqual(maskEntry({ id: 'y', config: { transport: 'stdio' } }), { id: 'y', config: { transport: 'stdio' } });
});
