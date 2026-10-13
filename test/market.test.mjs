import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCandidate, toEntry, isSecretInput, deriveMarketServerName } from '../lib/market.js';

/** A registry entry with only the fields a test cares about. */
function entry(over = {}) {
  return { name: 'ai.test/thing', description: 'a thing', version: '1.2.3', ...over };
}
const meta = (over = {}) => ({ _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: 'P', updatedAt: 'U', isLatest: true, ...over } } });

test('a remote streamable-http entry wins over its packages', () => {
  const c = toCandidate(entry({
    remotes: [{ type: 'streamable-http', url: 'https://api.test/mcp' }],
    packages: [{ registryType: 'npm', identifier: 'thing', version: '1.2.3', transport: { type: 'stdio' } }],
  }));
  assert.equal(c.ok, true);
  assert.equal(c.execution.kind, 'streamable-http');
  assert.equal(c.entryConfig.transport, 'streamable-http');
  assert.equal(c.entryConfig.url, 'https://api.test/mcp');
});

test('an npm package maps to npx with a pinned version', () => {
  const c = toCandidate(entry({ packages: [{ registryType: 'npm', identifier: '@scope/thing', version: '1.2.3', transport: { type: 'stdio' } }] }));
  assert.equal(c.entryConfig.transport, 'stdio');
  assert.equal(c.entryConfig.command, 'npx');
  assert.deepEqual(c.entryConfig.args, ['-y', '@scope/thing@1.2.3']);
  assert.equal(c.pinned, '1.2.3');
  assert.equal(c.entryConfig.failOnStartupError, true);
});

test('a pypi package maps to uvx with a == pin', () => {
  const c = toCandidate(entry({ packages: [{ registryType: 'pypi', identifier: 'thing', version: '1.2.3', transport: { type: 'stdio' } }] }));
  assert.equal(c.entryConfig.command, 'uvx');
  assert.deepEqual(c.entryConfig.args, ['thing==1.2.3']);
});

test('an oci package maps to docker run with a : pin', () => {
  const c = toCandidate(entry({ packages: [{ registryType: 'oci', identifier: 'ghcr.io/x/thing', version: '1.2.3', transport: { type: 'stdio' } }] }));
  assert.equal(c.entryConfig.command, 'docker');
  assert.deepEqual(c.entryConfig.args, ['run', '-i', '--rm', 'ghcr.io/x/thing:1.2.3']);
});

test('runtimeArguments precede the target and packageArguments follow it', () => {
  const c = toCandidate(entry({ packages: [{
    registryType: 'npm', identifier: 'thing', version: '1.0.0', transport: { type: 'stdio' },
    runtimeArguments: [{ type: 'positional', value: '-y' }],
    packageArguments: [{ type: 'named', name: '--port', value: '8080' }],
  }] }));
  assert.deepEqual(c.entryConfig.args, ['-y', '-y', 'thing@1.0.0', '--port', '8080']);
});

test('an sse-only entry is not installable and says why', () => {
  const c = toCandidate(entry({ remotes: [{ type: 'sse', url: 'https://api.test/sse' }] }));
  assert.equal(c.ok, false);
  assert.match(c.reason, /sse/);
  assert.equal(c.entryConfig, undefined);
});

test('cargo, nuget and mcpb packages are not installable and say why', () => {
  for (const registryType of ['cargo', 'nuget', 'mcpb']) {
    const c = toCandidate(entry({ packages: [{ registryType, identifier: 'x', version: '1.0.0', transport: { type: 'stdio' } }] }));
    assert.equal(c.ok, false, registryType);
    assert.match(c.reason, new RegExp(registryType));
  }
});

test('an entry with neither package nor remote is not installable', () => {
  const c = toCandidate(entry());
  assert.equal(c.ok, false);
  assert.match(c.reason, /neither/i);
});

test('isSecretInput catches all three signals', () => {
  assert.equal(isSecretInput({ name: 'PLAIN', isSecret: true }), true);
  assert.equal(isSecretInput({ name: 'PLAIN', isRequired: true, value: 'Bearer {api_key}' }), true);
  assert.equal(isSecretInput({ name: 'GITHUB_TOKEN' }), true);
  assert.equal(isSecretInput({ name: 'DEBUG', value: '1' }), false);
});

// rules.js rejects ANY non-!!js value on an AUTH-named key. A header called
// `Authorization` marked only by a template placeholder must therefore be
// treated as secret here, or the write pipeline refuses the candidate we built.
test('a secret-named header is routed to gaps, never into config.headers', () => {
  const c = toCandidate(entry({
    remotes: [{ type: 'streamable-http', url: 'https://api.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer {key}' }] }],
  }));
  assert.equal(c.entryConfig.headers, undefined);
  assert.deepEqual(c.gaps.map((g) => g.name), ['Authorization']);
  assert.equal(c.gaps[0].kind, 'secret');
});

test('a non-secret header is written', () => {
  const c = toCandidate(entry({
    remotes: [{ type: 'streamable-http', url: 'https://api.test/mcp', headers: [{ name: 'X-Tenant', value: 'acme' }] }],
  }));
  assert.deepEqual(c.entryConfig.headers, { 'X-Tenant': 'acme' });
});

test('secret env vars go to gaps and never into config.env', () => {
  const c = toCandidate(entry({ packages: [{
    registryType: 'npm', identifier: 'thing', version: '1.0.0', transport: { type: 'stdio' },
    environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true, description: 'your key' }, { name: 'DEBUG', default: '1' }],
  }] }));
  assert.deepEqual(c.entryConfig.env, { DEBUG: '1' });
  assert.deepEqual(c.gaps.map((g) => g.name), ['API_KEY']);
  assert.equal(c.gaps[0].required, true);
});

test('a non-secret, non-required env var with no value is skipped silently', () => {
  const c = toCandidate(entry({ packages: [{
    registryType: 'npm', identifier: 'thing', version: '1.0.0', transport: { type: 'stdio' },
    environmentVariables: [{ name: 'OPTIONAL_THING' }],
  }] }));
  assert.equal(c.entryConfig.env, undefined);
  assert.deepEqual(c.gaps, []);
});

test('a required argument with no value becomes a gap instead of a guess', () => {
  const c = toCandidate(entry({ packages: [{
    registryType: 'npm', identifier: 'thing', version: '1.0.0', transport: { type: 'stdio' },
    packageArguments: [{ type: 'positional', isRequired: true, valueHint: 'file_path' }],
  }] }));
  assert.deepEqual(c.entryConfig.args, ['-y', 'thing@1.0.0']);
  assert.equal(c.gaps.length, 1);
  assert.equal(c.gaps[0].kind, 'argument');
});

test('an unresolved url template becomes a gap and the entry is not installable', () => {
  const c = toCandidate(entry({ remotes: [{ type: 'streamable-http', url: 'https://api.test/{tenant}/mcp' }] }));
  assert.equal(c.ok, false);
  assert.match(c.reason, /unresolved template variable/);
  assert.equal(c.gaps[0].name, 'tenant');
});

test('a url template resolves from the transport variables', () => {
  const c = toCandidate(entry({ remotes: [{
    type: 'streamable-http', url: 'https://api.test/{tenant}/mcp',
    variables: { tenant: { value: 'acme' } },
  }] }));
  assert.equal(c.entryConfig.url, 'https://api.test/acme/mcp');
  assert.deepEqual(c.gaps, []);
});

test('a non-https remote url is refused', () => {
  const c = toCandidate(entry({ remotes: [{ type: 'streamable-http', url: 'http://insecure.test/mcp' }] }));
  assert.equal(c.ok, false);
});

test('an empty repository object does not throw', () => {
  const c = toCandidate(entry({ repository: {}, packages: [{ registryType: 'npm', identifier: 'x', version: '1.0.0', transport: { type: 'stdio' } }] }));
  assert.equal(c.ok, true);
  assert.equal(c.provenance.repositoryUrl, '');
});

test('a deprecated entry is still installable but carries the status', () => {
  const c = toCandidate({ ...entry({ packages: [{ registryType: 'npm', identifier: 'x', version: '1.0.0', transport: { type: 'stdio' } }] }), ...meta({ status: 'deprecated' }) });
  assert.equal(c.ok, true);
  assert.equal(c.provenance.status, 'deprecated');
});

test('deriveMarketServerName sanitises, clamps and de-duplicates', () => {
  assert.equal(deriveMarketServerName('ai.ankimcp/anki-mcp-server'), 'anki-mcp-server');
  assert.equal(deriveMarketServerName('ai.x/' + 'n'.repeat(40)), 'n'.repeat(32));
  assert.equal(deriveMarketServerName('ai.x/a b/c!d'), 'c-d');
  assert.equal(deriveMarketServerName('ai.x/thing', ['thing']), 'thing-2');
  assert.equal(deriveMarketServerName('ai.x/thing', ['thing', 'thing-2']), 'thing-3');
  // The suffix must not push the name past the official 32-char ceiling.
  const long = 'n'.repeat(32);
  assert.equal(deriveMarketServerName('ai.x/' + long, [long]).length, 32);
});

// Measured against the live registry: a large share of publishers register
// `…/mcp-server`. Taking the name half verbatim yields `serverName: mcp-server`,
// which identifies nothing and collides with the next publisher who does the
// same — so the namespace is the only part worth keeping.
test('a generic name half falls back to the publisher namespace', () => {
  assert.equal(deriveMarketServerName('ai.adadvisor/mcp-server'), 'adadvisor');
  assert.equal(deriveMarketServerName('ai.2kw/mcp-server'), '2kw');
  assert.equal(deriveMarketServerName('ai.agenttrust/mcp-server'), 'agenttrust');
  assert.equal(deriveMarketServerName('ai.x/mcp'), 'x');
  assert.equal(deriveMarketServerName('ai.x/server'), 'x');
  // A meaningful name half is still preferred over the namespace.
  assert.equal(deriveMarketServerName('ai.ankimcp/anki-mcp-server'), 'anki-mcp-server');
});

test('a generic name half with an unusable namespace still yields a name', () => {
  // Nothing identifies this one, so the registry's own tail is the most honest
  // answer available — inventing `server` would be no more informative.
  assert.equal(deriveMarketServerName('mcp-server'), 'mcp-server');
  assert.equal(deriveMarketServerName('!!!'), 'server');
  assert.equal(deriveMarketServerName(''), 'server');
  assert.equal(deriveMarketServerName(undefined), 'server');
});

test('toEntry produces the row shape renderEntryRow expects', () => {
  const c = toCandidate(entry({ packages: [{ registryType: 'npm', identifier: 'thing', version: '1.0.0', transport: { type: 'stdio' } }] }));
  const row = toEntry(c);
  assert.equal(row.id, 'mcp-thing');
  assert.equal(row.name, '@deepseek-ai/dsh-mcp-client');
  assert.equal(row.disabled, false);
  assert.equal(row.config, c.entryConfig);
});

test('toEntry refuses a candidate that is not installable', () => {
  assert.throws(() => toEntry({ ok: false, reason: 'sse transport is not supported' }), /not installable: sse/);
});
