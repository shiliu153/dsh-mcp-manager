import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { readJsExprs, scanJsTokens, describeJsExpr, toPanelView, prepareUpdate, applyUpdate } from '../lib/update.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(path.join(dir, 'fixtures/patch-sample.yml'), 'utf8');
// gamma's subtree: the only !!js in the fixture.
const GAMMA = 'serverName: gamma\ntransport: stdio\ncommand: node\nenv:\n  GAMMA_TOKEN: !!js require(\'fs\').readFileSync(\'C:/Users/x/gamma-token.txt\', \'utf8\').trim()';

function tmpPatch(text = SAMPLE) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'mcp-update-'));
  const f = path.join(d, 'cordis.patch.yml');
  writeFileSync(f, text);
  return f;
}

test('readJsExprs extracts expressions in document order and rejects odd forms', () => {
  const ok = readJsExprs(GAMMA);
  assert.equal(ok.ok, true);
  assert.equal(ok.exprs.length, 1);
  assert.match(ok.exprs[0], /^!!js require\('fs'\)/);
  const bad = readJsExprs('env:\n  A: !!js >\n    multi\n    line');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unsupported !!js form/);
});

test('scanJsTokens separates placeholders from raw expressions', () => {
  assert.deepEqual(scanJsTokens('Authorization: !!js «0»'), { tokens: [0], raw: [] });
  assert.deepEqual(scanJsTokens('GAMMA_TOKEN: !!js require("fs")'), { tokens: [], raw: ['GAMMA_TOKEN: !!js require("fs")'] });
});

test('describeJsExpr names the credential file it reads', () => {
  assert.equal(describeJsExpr("!!js require('fs').readFileSync('C:/Users/x/gamma-token.txt', 'utf8').trim()"),
    'credential file: C:/Users/x/gamma-token.txt');
  assert.match(describeJsExpr('!!js process.env.FOO'), /^expression: /);
});

test('toPanelView turns expressions into placeholders and keeps them out of the text', () => {
  const v = toPanelView(GAMMA);
  assert.equal(v.editable, true);
  assert.ok(v.configText.includes('GAMMA_TOKEN: !!js «0»'));
  assert.ok(!v.configText.includes('readFileSync'), 'the expression itself must not reach the browser');
  assert.deepEqual(v.jsExprs, ['credential file: C:/Users/x/gamma-token.txt']);
});

test('toPanelView masks a hardcoded secret and marks the row uneditable', () => {
  const v = toPanelView('serverName: x\ntransport: streamable-http\nurl: https://x/mcp\nheaders:\n  Authorization: Bearer abc123');
  assert.equal(v.editable, false);
  assert.match(v.reason, /hardcoded secret/);
  assert.ok(v.configText.includes('Authorization: B*****'));
  assert.ok(!v.configText.includes('abc123'));
});

test('prepareUpdate round-trips an untouched subtree', async () => {
  const file = tmpPatch();
  const before = readFileSync(file, 'utf8');
  // The panel's own fragment: placeholders, not expressions.
  const prep = await prepareUpdate({ file, id: 'mcp-gamma', fragment: toPanelView(GAMMA).configText });
  assert.equal(prep.ok, true);
  assert.equal(prep.candidate, before, 'no edit must reproduce the file byte-for-byte');
  assert.equal(prep.introducedJsExpr, 0);
});

test('prepareUpdate maps a multi-line flow config to its own error code', async () => {
  const file = tmpPatch("- id: mcp-f\n  name: '@deepseek-ai/dsh-mcp-client'\n  config: {serverName: f}\n");
  const prep = await prepareUpdate({ file, id: 'mcp-f', fragment: 'a: 1\nb: 2' });
  assert.equal(prep.ok, false);
  assert.equal(prep.code, 'flow_config_single_line');
});

test('prepareUpdate refills a placeholder from the row it belongs to', async () => {
  const file = tmpPatch();
  const view = toPanelView(GAMMA);
  const prep = await prepareUpdate({ file, id: 'mcp-gamma', fragment: `${view.configText}\n  toolCallTimeoutMs: 90000` });
  assert.equal(prep.ok, true);
  assert.ok(prep.normalized.includes("GAMMA_TOKEN: !!js require('fs')"), 'the expression is written back verbatim');
  assert.ok(prep.normalized.includes('toolCallTimeoutMs: 90000'));
  assert.equal(prep.jsExprCount, 1);
  assert.equal(prep.introducedJsExpr, 0);
});

test('prepareUpdate refuses a forged or out-of-range placeholder', async () => {
  const file = tmpPatch();
  const forged = await prepareUpdate({ file, id: 'mcp-gamma', fragment: 'serverName: gamma\nenv:\n  GAMMA_TOKEN: !!js «7»' });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'js_expression_forbidden');
});

test('prepareUpdate refuses a new raw expression for the panel but allows it for the CLI', async () => {
  const file = tmpPatch();
  const fragment = "serverName: gamma\ntransport: stdio\ncommand: node\nenv:\n  GAMMA_TOKEN: !!js require('fs').readFileSync('C:/x/t.txt','utf8').trim()\n  OTHER: !!js process.env.HOME";
  const panel = await prepareUpdate({ file, id: 'mcp-gamma', fragment });
  assert.equal(panel.ok, false);
  assert.equal(panel.code, 'js_expression_forbidden');

  const cli = await prepareUpdate({ file, id: 'mcp-gamma', fragment, allowJsExpr: true });
  assert.equal(cli.ok, true);
  assert.equal(cli.introducedJsExpr, 1);
});

test('prepareUpdate enforces the official rules on the candidate', async () => {
  const file = tmpPatch();
  const prep = await prepareUpdate({ file, id: 'mcp-gamma', fragment: 'serverName: gamma\ntransport: stdio' });
  assert.equal(prep.ok, false);
  assert.equal(prep.code, 'rules_failed');
  assert.match(prep.errors.join('; '), /requires command/);
});

test('prepareUpdate refuses a hardcoded secret and a duplicate serverName', async () => {
  const file = tmpPatch();
  const secret = await prepareUpdate({ file, id: 'mcp-gamma', fragment: 'serverName: gamma\ntransport: streamable-http\nurl: https://x/mcp\nheaders:\n  Authorization: Bearer abc' });
  assert.equal(secret.ok, false);
  assert.equal(secret.code, 'hardcoded_secret');

  const dup = await prepareUpdate({ file, id: 'mcp-gamma', fragment: 'serverName: alpha\ntransport: stdio\ncommand: node' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'duplicate_server_name');
});

test('applyUpdate writes, keeps a .bak and leaves other entries alone', async () => {
  const file = tmpPatch();
  // allowJsExpr: true is the CLI/agent-tool path, which may carry raw text.
  const r = await applyUpdate({ file, id: 'mcp-gamma', fragment: `${GAMMA}\ntoolCallTimeoutMs: 90000`, allowJsExpr: true });
  assert.equal(r.applied, true);
  assert.ok(r.backupPath.endsWith('.bak'));
  assert.equal(readFileSync(r.backupPath, 'utf8'), SAMPLE);
  const after = readFileSync(file, 'utf8');
  assert.ok(after.includes('toolCallTimeoutMs: 90000'));
  assert.ok(after.includes('mcp-alpha') && after.includes('mcp-beta'));
  assert.ok(after.includes("GAMMA_TOKEN: !!js require('fs')"), 'the expression survived');
});

test('applyUpdate refuses to write a stale read', async () => {
  const file = tmpPatch();
  await assert.rejects(() => applyUpdate({ file, id: 'mcp-gamma', fragment: 'serverName: gamma\ntransport: stdio\ncommand: node', expectMtime: 1 }), /FileChangedExternally/);
});
