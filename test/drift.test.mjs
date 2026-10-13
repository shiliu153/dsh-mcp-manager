import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCandidate, pinnedVersionOf, compareVersions, findInstalled, driftOf, rankByRelevance, candidateForRegistry } from '../lib/market.js';

const npmEntry = (identifier, version) => ({ registryType: 'npm', identifier, version, transport: { type: 'stdio' } });
const candidateFor = (identifier, version, over = {}) =>
  toCandidate({ name: 'ai.x/thing', version, packages: [npmEntry(identifier, version)], ...over });

test('pinnedVersionOf reads an npm pin', () => {
  assert.deepEqual(pinnedVersionOf({ args: ['-y', '@ankimcp/anki-mcp-server@0.27.0'] }),
    { type: 'npm', identifier: '@ankimcp/anki-mcp-server', version: '0.27.0' });
  assert.deepEqual(pinnedVersionOf({ args: ['-y', 'thing@1.2.3'] }),
    { type: 'npm', identifier: 'thing', version: '1.2.3' });
});

test('pinnedVersionOf reads a pypi pin', () => {
  assert.deepEqual(pinnedVersionOf({ args: ['thing==1.2.3'] }), { type: 'pypi', identifier: 'thing', version: '1.2.3' });
});

test('pinnedVersionOf reads an oci tag, and skips docker flags', () => {
  assert.deepEqual(pinnedVersionOf({ command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/x/thing:1.2.3'] }),
    { type: 'oci', identifier: 'ghcr.io/x/thing', version: '1.2.3' });
});

test('pinnedVersionOf returns null for the unpinned npx form the add path writes', () => {
  assert.equal(pinnedVersionOf({ args: ['-y', '@upstash/context7-mcp'] }), null);
  assert.equal(pinnedVersionOf({ args: [] }), null);
  assert.equal(pinnedVersionOf({}), null);
  assert.equal(pinnedVersionOf(undefined), null);
});

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.27.0', '0.28.0'), -1);
  assert.equal(compareVersions('v1.2.0', '1.2'), 0);
});

test('compareVersions treats a prerelease as older than its release', () => {
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta'), 1);
});

test('compareVersions refuses to guess on an unparseable version', () => {
  assert.equal(compareVersions('nightly', '1.0.0'), undefined);
  assert.equal(compareVersions('1.0.0', 'latest'), undefined);
});

test('findInstalled matches on the derived serverName first', () => {
  const c = candidateFor('@ankimcp/anki-mcp-server', '0.27.0', { name: 'ai.ankimcp/anki-mcp-server' });
  const hit = findInstalled(c, [{ id: 'mcp-anki-mcp-server', config: { serverName: 'anki-mcp-server' } }]);
  assert.equal(hit.id, 'mcp-anki-mcp-server');
});

test('findInstalled falls back to the execution surface when the name was changed', () => {
  const c = candidateFor('@ankimcp/anki-mcp-server', '0.27.0', { name: 'ai.ankimcp/anki-mcp-server' });
  const hit = findInstalled(c, [{ id: 'mcp-mine', config: { serverName: 'mine', transport: 'stdio', command: 'npx', args: ['-y', '@ankimcp/anki-mcp-server@0.27.0'] } }]);
  assert.equal(hit.id, 'mcp-mine');
});

test('findInstalled falls back to the url for a remote candidate', () => {
  const c = toCandidate({ name: 'ai.x/remote', version: '1.0.0', remotes: [{ type: 'streamable-http', url: 'https://api.test/mcp' }] });
  const hit = findInstalled(c, [{ id: 'mcp-other', config: { serverName: 'other', transport: 'streamable-http', url: 'https://api.test/mcp' } }]);
  assert.equal(hit.id, 'mcp-other');
});

test('findInstalled reports nothing when neither signal matches', () => {
  const c = candidateFor('@ankimcp/anki-mcp-server', '0.27.0', { name: 'ai.ankimcp/anki-mcp-server' });
  assert.equal(findInstalled(c, [{ id: 'mcp-x', config: { serverName: 'x', transport: 'stdio', command: 'npx', args: ['-y', 'other'] } }]), undefined);
});

test('driftOf reports behind, current and ahead', () => {
  const c = candidateFor('@ankimcp/anki-mcp-server', '0.28.0', { name: 'ai.ankimcp/anki-mcp-server' });
  const installed = (v) => ({ id: 'mcp-anki-mcp-server', config: { serverName: 'anki-mcp-server', command: 'npx', args: ['-y', `@ankimcp/anki-mcp-server@${v}`] } });
  assert.equal(driftOf(c, installed('0.27.0')).state, 'behind');
  assert.equal(driftOf(c, installed('0.28.0')).state, 'current');
  assert.equal(driftOf(c, installed('0.29.0')).state, 'ahead');
});

test('driftOf flags an unpinned install rather than claiming it is current', () => {
  const c = candidateFor('@ankimcp/anki-mcp-server', '0.28.0', { name: 'ai.ankimcp/anki-mcp-server' });
  const installed = { id: 'mcp-anki-mcp-server', config: { serverName: 'anki-mcp-server', command: 'npx', args: ['-y', '@ankimcp/anki-mcp-server'] } };
  assert.equal(driftOf(c, installed).state, 'unpinned');
});

test('driftOf declines to order an unparseable pair', () => {
  const c = candidateFor('@ankimcp/anki-mcp-server', 'nightly', { name: 'ai.ankimcp/anki-mcp-server' });
  const installed = { id: 'mcp-anki-mcp-server', config: { serverName: 'anki-mcp-server', command: 'npx', args: ['-y', '@ankimcp/anki-mcp-server@0.27.0'] } };
  const d = driftOf(c, installed);
  assert.equal(d.state, 'incomparable');
  assert.equal(d.installed, '0.27.0');
});

test('driftOf is undefined when nothing is installed', () => {
  const c = candidateFor('@ankimcp/anki-mcp-server', '0.28.0', { name: 'ai.ankimcp/anki-mcp-server' });
  assert.equal(driftOf(c, undefined), undefined);
});

test('rankByRelevance lifts description hits above name-only noise', () => {
  const rows = [
    { registryName: 'app.replit.austere-unsteady-pdf/free-agent-economy-lab', title: 'Free Agent Economy Lab', description: 'outcome verification' },
    { registryName: 'app.docwand/pdf', title: 'DocWand', description: 'Sign, fill, merge and split PDFs' },
  ];
  const ranked = rankByRelevance(rows, 'pdf');
  assert.equal(ranked[0].title, 'DocWand', 'the description hit wins');
});

test('rankByRelevance keeps the registry order for an empty query', () => {
  const rows = [{ title: 'a' }, { title: 'b' }];
  assert.deepEqual(rankByRelevance(rows, ''), rows);
});

// The installed row is itself in the list of registered serverNames, so a naive
// dedup suffixes the very entry we are trying to recognise: the panel stops
// saying "installed" and offers a second copy under `name-2`.
test('candidateForRegistry does not suffix the name of the entry it already matches', () => {
  const server = { name: 'ai.ankimcp/anki-mcp-server', version: '0.28.0', packages: [npmEntry('@ankimcp/anki-mcp-server', '0.28.0')] };
  const installed = [{ id: 'mcp-anki-mcp-server', config: { serverName: 'anki-mcp-server', transport: 'stdio', command: 'npx', args: ['-y', '@ankimcp/anki-mcp-server@0.27.0'] } }];
  const c = candidateForRegistry(server, installed);
  assert.equal(c.serverName, 'anki-mcp-server', 'the installed row must not push itself into a -2 suffix');
  assert.equal(findInstalled(c, installed).id, 'mcp-anki-mcp-server');
  assert.equal(driftOf(c, findInstalled(c, installed)).state, 'behind');
});

test('candidateForRegistry still suffixes a genuine name collision', () => {
  const server = { name: 'ai.other/thing', version: '1.0.0', packages: [npmEntry('other-thing', '1.0.0')] };
  const installed = [{ id: 'mcp-thing', config: { serverName: 'thing', transport: 'stdio', command: 'npx', args: ['-y', 'a-thing'] } }];
  assert.equal(candidateForRegistry(server, installed).serverName, 'thing-2');
});

test('candidateForRegistry returns an uninstallable entry unchanged', () => {
  const sse = { name: 'ai.x/sse', version: '1.0.0', remotes: [{ type: 'sse', url: 'https://x/sse' }] };
  const c = candidateForRegistry(sse, []);
  assert.equal(c.ok, false);
  assert.match(c.reason, /sse/);
});
