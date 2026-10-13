# dsh-mcp-manager 配置编辑实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task(用户全局约定:superpowers 类任务一律内联执行,不派发子 agent)。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 dsh-mcp-manager 补上"编辑已有 MCP 条目配置"的能力:面板、Host 工具、CLI 三个入口共用一条「原文 → 归一化 → `!!js` 令牌回填 → 官方 loader + 规则校验 → 原子写 + `.bak`」管线。

**Architecture:** 纯文本手术层(`lib/surgery.js`)只认行;策略层(新 `lib/update.js`)负责令牌协议与四道语义校验;写门(`lib/patchfile.js`)新增 `replaceConfig` 操作与 `preCommit` 钩子;三个入口(`lib/server.js` 路由、`lib/tools-bridge.js` 工具、`cli/mcp.js` 命令)只做适配。面板编辑区是原始 YAML 文本,`!!js` 显示为不可编辑令牌。

**Tech Stack:** Node ≥ 22(仅 `node:` 内置模块,零 npm 依赖),ESM,`node:test`,Windows 优先。

**Spec:** `docs/specs/2026-10-13-edit-config-design.md`

## Global Constraints

- 零 npm 依赖:`lib/`、`cli/`、`index.js` 只准 `import` `node:` 内置模块与仓库内相对路径。bundle 不带 `dependencies`,无安装脚本,无构建步骤。
- `"type": "module"`;`package.json` 含 `"private": true` 与 `dsh.bundle.patch`;不声明 `Config`;Host 导出形式:`export function apply(ctx)` + `export const inject = ['tools']` + `export const name`。
- 工具定义手工构造(官方 dsh-mcp-client 形状):`{ name, description, parameters: <JSON Schema object>, output: { schema, render }, execute }`,直接 `ctx.tools.register(def)`。
- 工具参数 schema 里枚举**必须**用 `enum`;`oneOf`/`anyOf`/`allOf` 的值必须是 schema 数组。v0.1.0 的 503 故障根因就是把 `oneOf` 当枚举用(`docs/records/2026-10-13-tool-schema-503.md`)。
- `serverName` 必须匹配 `^[A-Za-z0-9_-]{1,32}$`;`transport` ∈ {`stdio`,`streamable-http`};stdio 必填 `command`,http 必填 `url`;`toolCallTimeoutMs` 默认 `60000`。
- 秘密永不硬编码进 patch;凭据走独立文件 + `!!js` 表达式。
- patch 顶层条目边界:`^- (id|insert):`(列 0);insert 数组行边界:**与该块首个 `- id:` 同缩进**的行首 `- `(本计划 Task 1 修复)。
- 写操作六步:读原文 → 手术候选副本 → `loadOptionalPatches("dsh", candidate)` 校验 → 语义校验(`preCommit`)→ 写前 mtime 复核 → 原子写(tmp+rename)+ 落盘前 `.bak`。
- `!!js` 令牌形式固定为 `!!js «k»`(`«` U+00AB、`»` U+00BB)。
- 测试零依赖(`node:test`),fixture 一律放 `test/fixtures/`;凡触盘的操作用 `--file`/临时目录,测试永不写真实 `~/.dsh/cordis.patch.yml`。
- 每个任务结束必须 `git add` + `commit`(消息用英文 conventional commits)。
- 所有新代码注释用英文(与仓库现状一致),测试名与文档用中文/英文混排亦可。

---

### Task 1: 手术层 — 行块边界修复 + config 子树读写

**Files:**
- Modify: `lib/surgery.js`(顶部正则与 `parseTopBlocks`;文件末尾新增两个函数)
- Test: `test/surgery.test.mjs`(追加用例)
- Fixture: `test/fixtures/patch-block-args.yml`(新建)

**Interfaces:**
- Consumes: 无(本任务是最底层)
- Produces:
  - `readConfigBlock(text, id) → { kind: 'block'|'flow'|'absent', indent: number, baseIndent: number, configText: string, startLine: number, endLine: number } | undefined`
  - `replaceConfigBlock(text, id, fragment) → string`(id 不存在时 `throw new Error('entry not found: <id>')`)

- [ ] **Step 1: 写失败测试**

新建 fixture `test/fixtures/patch-block-args.yml`(块式 `args`,这正是旧 `ITEM_RE` 会截断的形态):

```yaml
- insert:
    - id: mcp-blocky
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: blocky
        transport: stdio
        command: npx
        args:
          - -y
          - blocky-mcp@1.0.0
    - id: mcp-next
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: next
        transport: stdio
        command: node
```

在 `test/surgery.test.mjs` 追加,并把 `readConfigBlock, replaceConfigBlock` 加进第 6 行的 import:

```js
const blocky = readFileSync(path.join(dir, 'fixtures/patch-block-args.yml'), 'utf8');

test('a block-style args sequence does not truncate the row', () => {
  const row = findRow(blocky, 'mcp-blocky');
  const lines = blocky.split('\n').slice(row.startLine, row.endLine + 1);
  assert.ok(lines.some(l => /^\s*- blocky-mcp@1\.0\.0\s*$/.test(l)), 'the nested sequence item must stay inside the row');
  assert.ok(lines.some(l => /serverName: blocky/.test(l)));
});

test('setDisabled keeps a block-style args row intact', () => {
  const out = setDisabled(blocky, 'mcp-blocky', true);
  assert.ok(out.includes('blocky-mcp@1.0.0'), 'args survive the edit');
  assert.ok(out.includes('serverName: next'), 'the following row is untouched');
  assert.ok(/^\s*disabled: true\s*$/m.test(out));
});

test('readConfigBlock returns the dedented subtree and its indent', () => {
  const b = readConfigBlock(sample, 'mcp-alpha');
  assert.equal(b.kind, 'block');
  assert.equal(b.indent, 8);           // insert row: id at 4 -> config at 6 -> subtree at 8
  assert.equal(b.baseIndent, 8);
  assert.equal(b.configText, ["serverName: alpha", "transport: stdio", "command: npx", "args: ['-y', 'alpha-mcp']"].join('\n'));
});

test('readConfigBlock handles bare entries, flow config and absent config', () => {
  assert.equal(readConfigBlock(sample, 'mcp-gamma').kind, 'block');
  assert.equal(readConfigBlock(sample, 'mcp-gamma').indent, 4);
  assert.equal(readConfigBlock(sample, 'nope'), undefined);

  const flow = "- id: mcp-f\n  name: 'x'\n  config: {serverName: f, transport: stdio, command: node}\n";
  const f = readConfigBlock(flow, 'mcp-f');
  assert.equal(f.kind, 'flow');
  assert.equal(f.configText, '{serverName: f, transport: stdio, command: node}');

  const absent = "- id: mcp-a\n  name: 'x'\n";
  assert.equal(readConfigBlock(absent, 'mcp-a').kind, 'absent');
  assert.equal(readConfigBlock(absent, 'mcp-a').indent, 4);
});

test('replaceConfigBlock round-trips byte-for-byte and preserves everything outside', () => {
  const b = readConfigBlock(sample, 'mcp-alpha');
  const out = replaceConfigBlock(sample, 'mcp-alpha', b.configText);
  assert.equal(out, sample, 'an unedited subtree must reproduce the file exactly');
});

test('replaceConfigBlock rewrites only the subtree, keeping id/name/comments', () => {
  // Pasted with a common 2-space indent, as a user would: the common prefix is
  // stripped and the fragment is re-indented to the entry's own depth.
  const fragment = ['  serverName: alpha', '  transport: stdio', '  command: npx', "  args: ['x']"].join('\n');
  const out = replaceConfigBlock(sample, 'mcp-alpha', fragment);
  assert.ok(out.includes('# keep this comment'));
  assert.ok(out.includes("    - id: mcp-alpha"));
  assert.ok(out.includes("      name: '@deepseek-ai/dsh-mcp-client'"));
  assert.ok(out.includes('        serverName: alpha'));
  assert.ok(out.includes('        command: npx'));
  assert.ok(out.includes("        args: ['x']"));
  assert.ok(out.includes('mcp-beta') && out.includes('mcp-gamma'));
});

test('replaceConfigBlock replaces a flow config in place and rejects multi-line input', () => {
  const flow = "- id: mcp-f\n  name: 'x'\n  config: {serverName: f}\n";
  const out = replaceConfigBlock(flow, 'mcp-f', '{serverName: f, transport: stdio, command: node}');
  assert.ok(out.includes('  config: {serverName: f, transport: stdio, command: node}'));
  assert.throws(() => replaceConfigBlock(flow, 'mcp-f', 'a: 1\nb: 2'), /single line/);
});

test('replaceConfigBlock inserts a config line when the entry has none', () => {
  const absent = "- id: mcp-a\n  name: '@deepseek-ai/dsh-mcp-client'\n";
  const out = replaceConfigBlock(absent, 'mcp-a', 'serverName: a\ntransport: stdio\ncommand: node');
  assert.equal(out, [
    "- id: mcp-a",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: a',
    '    transport: stdio',
    '    command: node',
    '',
  ].join('\n'));
});

test('replaceConfigBlock throws for an unknown id', () => {
  assert.throws(() => replaceConfigBlock(sample, 'nope', 'a: 1'), /entry not found: nope/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/surgery.test.mjs`
Expected: FAIL — `readConfigBlock is not a function`(以及块式 args 那条断言失败)。

- [ ] **Step 3: 修复行块边界**

`lib/surgery.js` 顶部,`ITEM_RE` 之后加入缩进感知判定,并把 `parseTopBlocks` 内两处 `ITEM_RE.test` 换成 `isItemAt(line, itemIndent)`:

```js
const ITEM_RE = /^(\s+)- /;

// Row boundary inside an `insert:` block: the marker must sit at the SAME
// indentation as that block's `- id:` line. The old rule (ITEM_RE, any
// indentation) mistook a nested block sequence for a new row:
//
//     - id: mcp-blocky
//       config:
//         args:
//           - -y          <- matched ITEM_RE -> the row ended here
//           - blocky-mcp
//
// findRow then returned a range truncated at `args:`, and every surgery that
// splices that range (setDisabled / remove / replaceConfigBlock) corrupted the
// entry. Flow-style args hid the bug; the editor makes block style reachable.
// `itemIndent === undefined` (no row seen yet) keeps the old behaviour.
function isItemAt(line, itemIndent) {
  if (itemIndent === undefined) return ITEM_RE.test(line);
  return new RegExp(`^ {${itemIndent}}- `).test(line);
}
```

`parseTopBlocks` 改为:

```js
export function parseTopBlocks(text) {
  const lines = toLf(text).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = TOP_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const kind = m[1] === 'insert' ? 'insert' : 'bare';
    const start = i;
    let j = i + 1;
    const rows = [];
    let itemIndent;
    while (j < lines.length && !TOP_RE.test(lines[j])) {
      if (kind === 'insert') {
        const rm = /^(\s+)- id:\s*(\S+)\s*$/.exec(lines[j]);
        if (rm) {
          itemIndent = rm[1].length;
          let k = j + 1;
          while (k < lines.length && !TOP_RE.test(lines[k]) && !isItemAt(lines[k], itemIndent)) k++;
          rows.push({ id: stripQuotes(rm[2]), startLine: j, endLine: k - 1 });
          j = k;
          continue;
        }
      }
      j++;
    }
    const block = { kind, startLine: start, endLine: j - 1 };
    if (kind === 'insert') block.rows = rows;
    else block.id = stripQuotes((m[2] || '').trim());
    blocks.push(block);
    i = j;
  }
  return blocks;
}
```

- [ ] **Step 4: 实现 config 子树读写**

`lib/surgery.js` 文件末尾追加:

```js
const CONFIG_RE = /^(\s*)config:\s*(.*)$/;
/** A simple mapping key, which is all the mcp-client config uses. */
const KEY_RE = /^(\s*[A-Za-z0-9_-]+:\s*)/;

function indentOf(line) { return /^( *)/.exec(line)[1].length; }

/** Common leading-space count of the non-blank lines. */
function commonIndent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    min = Math.min(min, indentOf(l));
  }
  return min === Infinity ? 0 : min;
}

/** Drop up to `n` leading spaces per line; blank lines become empty. */
function dedent(lines, n) {
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(Math.min(n, indentOf(l)))));
}

/**
 * Locate one entry's `config:` subtree.
 *
 * kind 'block'  — `config:` alone on its line; the subtree follows.
 * kind 'flow'   — `config: {…}` inline; configText is the inline value.
 * kind 'absent' — the entry has no `config:` line; startLine is the insertion
 *                 point (right after `- id:`, or after a leading `name:` /
 *                 `disabled:` pair).
 * `indent` is the subtree indentation to write back with (the file's own
 * `config:` indent + 2, or `- id:` indent + 4 when absent); `baseIndent` is
 * what the subtree actually used. `configText` is dedented by `baseIndent`.
 */
export function readConfigBlock(text, id) {
  const row = findRow(text, id);
  if (!row) return undefined;
  const lines = splitLines(toLf(text));
  const seg = lines.slice(row.startLine, row.endLine + 1);
  const idIndent = /^( *)- id:/.exec(seg[0])?.[1]?.length ?? 0;
  let cfgIdx = -1;
  for (let i = 1; i < seg.length; i++) if (CONFIG_RE.test(seg[i])) { cfgIdx = i; break; }
  if (cfgIdx < 0) {
    let at = 1;
    while (at < seg.length && /^\s*(name|disabled):/.test(seg[at])) at++;
    return { kind: 'absent', indent: idIndent + 4, baseIndent: idIndent + 4, configText: '',
             startLine: row.startLine + at, endLine: row.startLine + at - 1 };
  }
  const m = CONFIG_RE.exec(seg[cfgIdx]);
  const cfgIndent = m[1].length;
  const inline = m[2].trim();
  if (inline) {
    return { kind: 'flow', indent: cfgIndent + 2, baseIndent: cfgIndent + 2, configText: inline,
             startLine: row.startLine + cfgIdx, endLine: row.startLine + cfgIdx };
  }
  let end = cfgIdx + 1;
  while (end < seg.length && (seg[end].trim() === '' || indentOf(seg[end]) > cfgIndent)) end++;
  while (end > cfgIdx + 1 && seg[end - 1].trim() === '') end--;
  const sub = seg.slice(cfgIdx + 1, end);
  const baseIndent = commonIndent(sub);
  return { kind: 'block', indent: cfgIndent + 2, baseIndent,
           configText: dedent(sub, baseIndent).join('\n'),
           startLine: row.startLine + cfgIdx + 1, endLine: row.startLine + end - 1 };
}

/** Strip a fragment's common indent, drop blank edges, re-indent by `indent`. */
function normalizeFragment(fragment, indent) {
  const raw = toLf(String(fragment ?? '')).split('\n');
  while (raw.length && raw[0].trim() === '') raw.shift();
  while (raw.length && raw[raw.length - 1].trim() === '') raw.pop();
  if (raw.length === 0) return [];
  const base = commonIndent(raw);
  return dedent(raw, base).map((l) => (l === '' ? '' : ' '.repeat(indent) + l));
}

/**
 * Replace one entry's `config:` subtree with `fragment`, touching nothing else:
 * the comment block above the entry, `- id:`, `name:` and `disabled:` all stay
 * byte-identical, as do all other entries.
 *
 * Round-trip invariant: feeding back readConfigBlock().configText reproduces
 * the file byte-for-byte whenever the subtree used the canonical indentation
 * (config indent + 2). A deeper-than-canonical subtree is normalized instead.
 */
export function replaceConfigBlock(text, id, fragment) {
  const block = readConfigBlock(text, id);
  if (!block) throw new Error(`entry not found: ${id}`);
  const lines = splitLines(toLf(text));
  const body = normalizeFragment(fragment, block.indent);
  if (block.kind === 'flow') {
    if (body.length !== 1) throw new Error('flow-style config accepts a single line');
    // Replacer function, not a replacement string: the inline value may contain `$&`.
    lines[block.startLine] = lines[block.startLine].replace(/^(\s*config:\s*).*$/, (_m, head) => head + body[0].trim());
    return joinLines(lines);
  }
  if (block.kind === 'absent') {
    lines.splice(block.startLine, 0, ' '.repeat(block.indent - 2) + 'config:', ...body);
    return joinLines(lines);
  }
  lines.splice(block.startLine, block.endLine - block.startLine + 1, ...body);
  return joinLines(lines);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/surgery.test.mjs`
Expected: PASS(全部,含既有 12 条)。

- [ ] **Step 6: 跑全量回归**

Run: `node --test "test/*.test.mjs"`
Expected: PASS(既有 98 条 + 新增;行块边界改动不得影响 `cli`/`patchfile`/`server` 测试)。

- [ ] **Step 7: Commit**

```bash
git add lib/surgery.js test/surgery.test.mjs test/fixtures/patch-block-args.yml
git commit -m "feat: read and replace one entry's config subtree"
```

---

### Task 2: 读门 — 从文本解析候选(`lib/dump.js`)

**Files:**
- Modify: `lib/dump.js`(末尾新增导出)
- Test: `test/dump.test.mjs`(追加)

**Interfaces:**
- Consumes: 既有 `loadPatchStructured(file)`
- Produces: `loadPatchText(text, { dir } = {}) → Promise<{ entries, warnings }>`(临时文件写在 `dir ?? os.tmpdir()`,**始终**删除)

- [ ] **Step 1: 写失败测试**

在 `test/dump.test.mjs` 追加(该文件现有 import 只有 `test`/`assert`/`fileURLToPath`/`path`/`loadPatchStructured`,需补 `readFileSync, readdirSync` from `node:fs`、`os` from `node:os`、`loadPatchText`):

```js
test('loadPatchText parses text without leaving a temp file behind', async () => {
  const text = readFileSync(path.join(dir, 'fixtures/patch-sample.yml'), 'utf8');
  const dirs = readdirSync(os.tmpdir()).filter((f) => f.startsWith('dsh-patch-'));
  const { entries } = await loadPatchText(text);
  assert.deepEqual(entries.map((e) => e.id), ['mcp-alpha', 'mcp-beta', 'mcp-gamma']);
  assert.equal(entries[0].config.serverName, 'alpha');
  assert.deepEqual(readdirSync(os.tmpdir()).filter((f) => f.startsWith('dsh-patch-')), dirs, 'no temp file is left');
});

test('loadPatchText rejects text the official loader cannot parse', async () => {
  await assert.rejects(() => loadPatchText('- insert:\n    - id: x\n   broken: [\n'), /patch parse failed/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/dump.test.mjs`
Expected: FAIL — `loadPatchText is not a function`。

- [ ] **Step 3: 实现**

`lib/dump.js` 末尾追加(顶部 import 补 `import fs from 'node:fs'; import os from 'node:os';`):

```js
/**
 * Parse patch TEXT through the official loader.
 *
 * loadOptionalPatches() takes a path, so the text goes to a temp file that is
 * removed in a finally block — the caller (the update policy layer) needs to
 * validate a candidate it has only in memory.
 */
export async function loadPatchText(text, { dir } = {}) {
  const tmp = path.join(dir ?? os.tmpdir(), `dsh-patch-${process.pid}-${Date.now()}.yml`);
  fs.writeFileSync(tmp, text);
  try {
    return await loadPatchStructured(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/dump.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/dump.js test/dump.test.mjs
git commit -m "feat: parse patch text through the official loader"
```

---

### Task 3: 策略层 — `!!js` 令牌协议与 `lib/update.js`

**Files:**
- Create: `lib/update.js`
- Modify: `lib/patchfile.js`(新增 `replaceConfig` 操作 + `preCommit` 钩子)
- Test: `test/update.test.mjs`(新建), `test/patchfile.test.mjs`(追加)

**Interfaces:**
- Consumes: `readConfigBlock` / `replaceConfigBlock`(Task 1)、`loadPatchText`(Task 2)、`validateEntry` / `checkSecrets` / `SERVER_NAME_RE`(`lib/rules.js`)、`isMcpClientRow`(`lib/rows.js`)、`applySurgeryAsync`(`lib/patchfile.js`)
- Produces:
  - `readJsExprs(configText) → { ok: true, exprs: string[] } | { ok: false, reason: string }`
  - `scanJsTokens(fragment) → { tokens: number[], raw: string[] }`
  - `describeJsExpr(expr) → string`
  - `toPanelView(configText) → { configText: string, jsExprs: string[], editable: boolean, reason: string }`
  - `prepareUpdate({ file, id, fragment, allowJsExpr = false }) → { ok, code, errors: string[], warnings: string[], normalized, candidate?, jsExprCount, introducedJsExpr }`
  - `applyUpdate({ file, id, fragment, allowJsExpr = false, expectMtime }) → { applied: true, backupPath, jsExprCount, introducedJsExpr }`
  - `lib/patchfile.js`:`applySurgeryAsync({ …, preCommit })`,操作 `{ type: 'replaceConfig', id, fragment }`

- [ ] **Step 1: 写失败测试** `test/update.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
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
  assert.deepEqual(scanJsTokens("Authorization: !!js «0»"), { tokens: [0], raw: [] });
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
  const stale = 1;
  await assert.rejects(() => applyUpdate({ file, id: 'mcp-gamma', fragment: 'serverName: gamma\ntransport: stdio\ncommand: node', expectMtime: stale }), /FileChangedExternally/);
});
```

`test/patchfile.test.mjs` 追加:

```js
test('applySurgeryAsync runs preCommit and aborts the write when it throws', async () => {
  const file = tmpPatch(SAMPLE);
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(() => applySurgeryAsync({
    file,
    operation: { type: 'replaceConfig', id: 'mcp-gamma', fragment: 'serverName: gamma\ntransport: stdio\ncommand: node' },
    preCommit: async () => { throw new Error('semantic veto'); },
  }), /semantic veto/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the live file is untouched');
});

test('applySurgeryAsync applies the replaceConfig operation', async () => {
  const file = tmpPatch(SAMPLE);
  const r = await applySurgeryAsync({
    file,
    operation: { type: 'replaceConfig', id: 'mcp-gamma', fragment: 'serverName: gamma\ntransport: stdio\ncommand: node' },
  });
  assert.equal(r.applied, true);
  assert.ok(fs.readFileSync(file, 'utf8').includes('serverName: gamma'));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('GAMMA_TOKEN'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/update.test.mjs test/patchfile.test.mjs`
Expected: FAIL — 模块不存在 / `unknown surgery operation: replaceConfig`。

- [ ] **Step 3: 写门 — `replaceConfig` 与 `preCommit`**

`lib/patchfile.js`:

```js
import { removeEntry, setDisabled, appendEntry, replaceConfigBlock } from './surgery.js';
```

```js
function doSurgery(text, operation) {
  switch (operation.type) {
    case 'appendEntry': return appendEntry(text, operation.row);
    case 'remove': return removeEntry(text, operation.id);
    case 'setDisabled': return setDisabled(text, operation.id, operation.value);
    case 'replaceConfig': return replaceConfigBlock(text, operation.id, operation.fragment);
    default: throw new Error(`unknown surgery operation: ${operation.type}`);
  }
}
```

`applySurgeryAsync` 的签名与校验段:

```js
/**
 * Async canonical pipeline — the one callers should use.
 *
 * `preCommit(candidateText)` is the semantic gate: the official loader proves
 * the candidate is parseable YAML, and preCommit proves it is a *valid entry*
 * (official field rules, no hardcoded secret, unique serverName). It runs after
 * the loader and before the write, so a rejection leaves the live file alone.
 */
export async function applySurgeryAsync({ file, operation, validate = true, expectMtime, preCommit } = {}) {
  const original = fs.readFileSync(file, 'utf8');
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (expectMtime !== undefined && Math.abs(expectMtime - mtimeMs) > 1) {
    throw new Error(`FileChangedExternally: ${file} changed on disk since it was read (expected mtime ${expectMtime}, got ${mtimeMs})`);
  }
  const candidate = doSurgery(original, operation);
  if (validate) {
    const candidateFile = file + '.candidate';
    fs.writeFileSync(candidateFile, candidate);
    try {
      await loadPatchStructured(candidateFile);
      if (preCommit) await preCommit(candidate);
    } catch (e) {
      throw new Error(`candidate failed validation (kept at ${candidateFile}): ${e.message}`);
    }
    return commit(file, candidate, mtimeMs, candidateFile);
  }
  return commit(file, candidate, mtimeMs);
}
```

- [ ] **Step 4: 实现 `lib/update.js`**

```js
// Edit policy for one existing entry: the !!js placeholder protocol plus the
// four semantic gates the write pipeline cannot know about.
//
// The panel is NOT a trust boundary. A `!!js` scalar is evaluated by the
// harness Loader at runtime, so accepting a new expression from the browser
// would hand arbitrary code execution in the host process to anything that can
// POST to the route. The panel therefore submits opaque placeholders, and this
// module is what turns them back into the row's OWN expressions — never into a
// new one. The CLI and the agent tool are trusted local surfaces and may write
// raw expressions, exactly like hand-editing the patch file.
import fs from 'node:fs';
import { readConfigBlock, replaceConfigBlock, toLf } from './surgery.js';
import { validateEntry, checkSecrets, SECRET_KEY_RE } from './rules.js';
import { isMcpClientRow } from './rows.js';
import { loadPatchText } from './dump.js';
import { applySurgeryAsync } from './patchfile.js';

/** `!!js «3»` — the placeholder the panel sees and sends back. */
const TOKEN_RE = /^(\s*[A-Za-z0-9_-]+:\s*)!!js\s*«(\d+)»\s*$/;
const VALUE_JS_RE = /^(\s*[A-Za-z0-9_-]+:\s*)(!!js\b.*?)\s*$/;
const CRED_RE = /readFileSync\(\s*['"]([^'"]+)['"]/;

/** Every `!!js` expression of one config subtree, in document order. */
export function readJsExprs(configText) {
  const exprs = [];
  for (const line of toLf(String(configText ?? '')).split('\n')) {
    const m = VALUE_JS_RE.exec(line);
    if (m) { exprs.push(m[2]); continue; }
    if (/!!js/.test(line)) return { ok: false, reason: `unsupported !!js form: ${line.trim()}` };
  }
  return { ok: true, exprs };
}

/** Split a submitted fragment into placeholder indices and raw expressions. */
export function scanJsTokens(fragment) {
  const tokens = [], raw = [];
  for (const line of toLf(String(fragment ?? '')).split('\n')) {
    const t = TOKEN_RE.exec(line);
    if (t) { tokens.push(Number(t[2])); continue; }
    if (/!!js/.test(line)) raw.push(line.trim());
  }
  return { tokens, raw };
}

/** Human-readable description of one expression, for the panel's hint line. */
export function describeJsExpr(expr) {
  const m = CRED_RE.exec(expr);
  if (m) return `credential file: ${m[1]}`;
  const one = String(expr).replace(/\s+/g, ' ').trim();
  return `expression: ${one.length > 60 ? one.slice(0, 60) + '…' : one}`;
}

/** What the panel may see: placeholders instead of expressions, secrets masked. */
export function toPanelView(configText) {
  const js = readJsExprs(configText);
  if (!js.ok) return { configText, jsExprs: [], editable: false, reason: js.reason };
  let text = toLf(String(configText ?? ''));
  let editable = true, reason = '';
  if (!checkSecrets(text).ok) {
    text = text.split('\n').map((l) => {
      const m = VALUE_JS_RE.exec(l);
      if (m) return l;                                    // an expression is not a hardcoded secret
      const key = /^\s*([A-Za-z0-9_-]+):/.exec(l)?.[1];
      return key && SECRET_KEY_RE.test(key) ? `${/^(\s*)/.exec(l)[1]}${key}: B*****` : l;
    }).join('\n');
    editable = false;
    reason = 'entry contains a hardcoded secret; fix it from the CLI or the agent tool';
  }
  let i = 0;
  text = text.split('\n').map((l) => {
    const m = VALUE_JS_RE.exec(l);
    return m ? `${m[1]}!!js «${i++}»` : l;
  }).join('\n');
  return { configText: text, jsExprs: js.exprs.map(describeJsExpr), editable, reason };
}

function failure(code, errors, warnings = [], extra = {}) {
  return { ok: false, code, errors, warnings, normalized: '', jsExprCount: 0, introducedJsExpr: 0, ...extra };
}

/**
 * Dry run: normalize the fragment, refill placeholders from THIS row's own
 * expressions, and run the semantic gates against a candidate built in memory.
 * Never writes.
 */
export async function prepareUpdate({ file, id, fragment, allowJsExpr = false }) {
  const text = fs.readFileSync(file, 'utf8');
  const block = readConfigBlock(text, id);
  if (!block) throw new Error(`entry not found: ${id}`);
  const own = readJsExprs(block.configText);
  if (!own.ok) return failure('unsupported_js_form', [own.reason]);
  const { tokens, raw } = scanJsTokens(fragment);
  if (raw.length && !allowJsExpr) {
    return failure('js_expression_forbidden',
      [`!!js expressions cannot be added or edited here: ${raw[0]} — use the CLI or the agent tool`]);
  }
  for (const k of tokens) {
    if (!Number.isInteger(k) || k < 0 || k >= own.exprs.length) {
      return failure('js_expression_forbidden', [`unknown !!js placeholder «${k}»`]);
    }
  }
  let normalized = String(fragment ?? '');
  for (const k of tokens) {
    // A replacer function, not a replacement string: the expressions contain
    // `${…}` and `$` sequences that String.replace would otherwise interpret.
    normalized = normalized.replace(new RegExp(`!!js\\s*«${k}»`), () => own.exprs[k]);
  }
  const after = readJsExprs(normalized);
  if (!after.ok) return failure('unsupported_js_form', [after.reason]);
  const jsExprCount = after.exprs.length;
  const introducedJsExpr = jsExprCount - own.exprs.length;

  let candidate;
  try {
    candidate = replaceConfigBlock(text, id, normalized);
  } catch (e) {
    const msg = String(e.message || e);
    const code = /single line/.test(msg) ? 'flow_config_single_line' : 'candidate_invalid';
    return failure(code, [msg], [], { normalized, jsExprCount, introducedJsExpr });
  }
  const { errors, warnings } = await semanticCheck(candidate, id, normalized);
  if (errors.length) {
    const code = errors[0].code;
    return failure(code, errors.map((e) => e.message), warnings, { normalized, jsExprCount, introducedJsExpr });
  }
  return { ok: true, code: '', errors: [], warnings, normalized, candidate, jsExprCount, introducedJsExpr };
}

/** The three gates that need a finished candidate: rules, secrets, uniqueness. */
async function semanticCheck(candidateText, id, fragment) {
  const errors = [], warnings = [];
  for (const e of checkSecrets(fragment).errors) errors.push({ code: 'hardcoded_secret', message: e });
  let entries;
  try {
    ({ entries } = await loadPatchText(candidateText));
  } catch (e) {
    return { errors: [{ code: 'candidate_invalid', message: `candidate does not parse: ${e.message}` }], warnings };
  }
  const row = entries.find((e) => e.id === id);
  if (!row) errors.push({ code: 'candidate_invalid', message: `entry disappeared from the candidate: ${id}` });
  else {
    const v = validateEntry(row.config ?? {});
    for (const e of v.errors) errors.push({ code: 'rules_failed', message: e });
    warnings.push(...v.warnings);
  }
  const seen = new Map();
  for (const e of entries.filter(isMcpClientRow)) {
    const n = e.config?.serverName;
    if (!n) continue;
    if (seen.has(n)) errors.push({ code: 'duplicate_server_name', message: `duplicate serverName: ${n} (${seen.get(n)} and ${e.id})` });
    else seen.set(n, e.id);
  }
  return { errors, warnings };
}

/** Dry run, then write through the guarded pipeline. */
export async function applyUpdate({ file, id, fragment, allowJsExpr = false, expectMtime }) {
  const prep = await prepareUpdate({ file, id, fragment, allowJsExpr });
  if (!prep.ok) {
    const e = new Error(prep.errors.join('; '));
    e.code = prep.code;
    e.errors = prep.errors;
    throw e;
  }
  const r = await applySurgeryAsync({
    file,
    expectMtime,
    operation: { type: 'replaceConfig', id, fragment: prep.normalized },
    preCommit: async (candidateText) => {
      const s = await semanticCheck(candidateText, id, prep.normalized);
      if (s.errors.length) throw new Error(s.errors.map((e) => e.message).join('; '));
    },
  });
  return { applied: true, backupPath: r.backupPath, jsExprCount: prep.jsExprCount, introducedJsExpr: prep.introducedJsExpr };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test test/update.test.mjs test/patchfile.test.mjs test/surgery.test.mjs`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add lib/update.js lib/patchfile.js test/update.test.mjs test/patchfile.test.mjs
git commit -m "feat: placeholder-safe config update policy"
```

---

### Task 4: 面板路由 — `POST /update` 与 `/servers` 新字段

**Files:**
- Modify: `lib/server.js`
- Test: `test/server.test.mjs`(追加)

**Interfaces:**
- Consumes: `prepareUpdate` / `applyUpdate` / `toPanelView`(Task 3)
- Produces: 路由 `POST /api/dsh-mcp-manager/update`;`GET /api/dsh-mcp-manager/servers` 顶层新增 `mtimeMs`,每行新增 `configText` / `jsExprs` / `editable` / `editReason`

- [ ] **Step 1: 写失败测试**

在 `test/server.test.mjs` 追加。该文件已有的助手:`fakeCtx({ liveNames })`、`routeFor(routes, method, suffix)`、`get(route)`、`post(route, body)`、`copyFixture()`、`stubProbe`;fixture 是 `fixtures/patch-servers.yml`。**另有两处既有断言必须一起改**,否则新增字段会让它们失败:

其一,第 55-56 行的 `assert.deepEqual(alpha, {...})` 补上新字段:

```js
  assert.deepEqual(alpha, { id: 'mcp-alpha', serverName: 'alpha', transport: 'stdio',
    command: 'npx', args: ['-y', 'alpha-mcp'], url: '', disabled: false, live: true,
    configText: "serverName: alpha\ntransport: stdio\ncommand: npx\nargs: ['-y', 'alpha-mcp']",
    jsExprs: [], editable: true, editReason: '' });
```

其二,第 64-68 行的泄漏守卫改成"表达式不外泄",并显式承认凭据**文件引用**是有意暴露的:

```js
test('GET /servers never leaks a credential value', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const text = await (await get(routeFor(routes, 'GET', '/servers'))).text();
  assert.ok(!text.includes('readFileSync'), 'the raw expression must not reach the browser');
  // The credential FILE reference is exposed on purpose: the panel shows
  // `GAMMA_TOKEN: !!js «0»` and the hint line has to say which file it reads,
  // otherwise the placeholder is meaningless. The file's contents never are.
  assert.ok(text.includes('credential file: C:/Users/x/gamma-token.txt'));
});
```

然后追加:

```js
test('GET /servers exposes the editable subtree with placeholders', async () => {
  const routes = createRoutes(fakeCtx(), { patchPath: fixture });
  const res = await get(routeFor(routes, 'GET', '/servers'));
  const body = await res.json();
  assert.equal(typeof body.mtimeMs, 'number');
  const gamma = body.servers.find((s) => s.id === 'mcp-gamma');
  assert.equal(gamma.editable, true);
  assert.ok(gamma.configText.includes('GAMMA_TOKEN: !!js «0»'));
  assert.ok(!gamma.configText.includes('readFileSync'));
  assert.deepEqual(gamma.jsExprs, ['credential file: C:/Users/x/gamma-token.txt']);
});

test('POST /update dry-runs, then writes and probes', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file, probe: stubProbe });
  const update = routeFor(routes, 'POST', '/update');

  const dry = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio\ncommand: node' });
  assert.equal(dry.status, 200);
  assert.equal((await dry.json()).written, false);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('toolCallTimeoutMs'), 'dry run must not write');

  const ok = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio\ncommand: node\ntoolCallTimeoutMs: 90000', confirm: true });
  const body = await ok.json();
  assert.equal(body.written, true);
  assert.ok(body.backup.endsWith('.bak'));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('toolCallTimeoutMs: 90000'));
  assert.match(text, /# keep this comment/, 'comments survive');
  assert.deepEqual(body.probe, { ok: true, toolCount: 3 });
});

test('POST /update rejects a new !!js expression, a bad rule and a stale read', async () => {
  const file = copyFixture();
  const routes = createRoutes(fakeCtx(), { patchPath: file, probe: stubProbe });
  const update = routeFor(routes, 'POST', '/update');

  const js = await post(update, { id: 'mcp-gamma', config: "serverName: gamma\ntransport: stdio\ncommand: node\nenv:\n  X: !!js process.env.HOME" });
  assert.equal(js.status, 400);
  assert.equal((await js.json()).error.code, 'js_expression_forbidden');

  const rules = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio' });
  assert.equal(rules.status, 400);
  assert.equal((await rules.json()).error.code, 'rules_failed');

  const secret = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: streamable-http\nurl: https://x/mcp\nheaders:\n  Authorization: Bearer abc' });
  assert.equal((await secret.json()).error.code, 'hardcoded_secret');

  const stale = await post(update, { id: 'mcp-gamma', config: 'serverName: gamma\ntransport: stdio\ncommand: node', confirm: true, expectMtime: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'file_changed');

  const missing = await post(update, { id: 'nope', config: 'a: 1' });
  assert.equal(missing.status, 404);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/server.test.mjs`
Expected: FAIL — `/update` 404(未注册路由),`mtimeMs` undefined。

- [ ] **Step 3: 实现**

`lib/server.js`:import 补 `import fs from 'node:fs'`(已有)、`import { prepareUpdate, applyUpdate, toPanelView } from './update.js';`。

`handleServers` 改为返回编辑视图:

```js
async function handleServers(ctx, patchPath) {
  const loaded = await loadOrFail(patchPath);
  if (loaded.response) return loaded.response;
  const { available, names } = liveServers(ctx);
  const servers = loaded.entries.filter(isMcpClientRow).map(maskEntry).map((e) => {
    const c = e.config ?? {};
    return {
      id: e.id,
      serverName: c.serverName ?? '',
      transport: c.transport ?? '',
      command: c.command ?? '',
      args: Array.isArray(c.args) ? c.args : [],
      url: c.url ?? '',
      disabled: e.disabled === true,
      live: available && names.has(c.serverName),
    };
  });
  // The panel edits raw text, so it needs the row's own subtree — with !!js
  // values replaced by placeholders (see lib/update.js) and secrets masked.
  const text = fs.readFileSync(patchPath, 'utf8');
  for (const s of servers) {
    const block = readConfigBlock(text, s.id);
    const view = toPanelView(block ? block.configText : '');
    s.configText = view.configText;
    s.jsExprs = view.jsExprs;
    s.editable = view.editable && Boolean(block);
    s.editReason = block ? view.reason : 'entry not found in the patch text';
  }
  return json({ patch: patchPath, mtimeMs: fs.statSync(patchPath).mtimeMs, resourcesAvailable: available, servers });
}
```

(`import { readConfigBlock } from './surgery.js';` 一并加入。)

新增 `handleUpdate`:

```js
async function handleUpdate(req, patchPath, probe) {
  const parsed = await readJson(req);
  if (parsed.response) return parsed.response;
  const { id, config, confirm, expectMtime } = parsed.body ?? {};
  if (typeof id !== 'string' || !id) return fail('bad_request', 'id is required', 400);
  if (typeof config !== 'string') return fail('bad_request', 'config must be a string', 400);
  const loaded = await loadOrFail(patchPath);
  if (loaded.response) return loaded.response;
  if (!loaded.entries.some((e) => e.id === id)) return fail('not_found', `entry not found: ${id}`, 404);

  let prep;
  try {
    prep = await prepareUpdate({ file: patchPath, id, fragment: config, allowJsExpr: false });
  } catch (e) {
    return fail('internal', String(e.message || e), 500);
  }
  if (!prep.ok) return fail(prep.code, prep.errors.join('; '), 400);
  if (confirm !== true) {
    return json({ written: false, preview: prep.normalized, warnings: prep.warnings, jsExprCount: prep.jsExprCount });
  }
  try {
    const r = await applyUpdate({ file: patchPath, id, fragment: config, allowJsExpr: false, expectMtime });
    const { entries } = await loadPatchStructured(patchPath);
    const entry = entries.find((e) => e.id === id);
    const pr = await probe(entry?.config ?? {}, { timeoutMs: clampProbeTimeoutMs(60) });
    return json({
      written: true, backup: r.backupPath, preview: prep.normalized,
      jsExprCount: r.jsExprCount,
      probe: pr.ok ? { ok: true, toolCount: pr.toolCount ?? 0 } : { ok: false, error: pr.error ?? 'probe failed' },
    });
  } catch (e) {
    const msg = String(e.message || e);
    if (/FileChangedExternally/.test(msg)) return fail('file_changed', msg, 409);
    if (e.code) return fail(e.code, msg, 400);
    return fail('candidate_invalid', msg, 400);
  }
}
```

`createRoutes` 数组追加(放在 `/add` 之前):

```js
    { path: `${ROUTE_PREFIX}/update`, methods: ['POST'], requestBody: 'buffered',
      fetch: (req) => handleUpdate(req, patchPath, probe) },
```

`handleServers` 需要 `readConfigBlock`,所以 `lib/server.js` 顶部 import 加 `import { readConfigBlock } from './surgery.js';`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/server.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/server.js test/server.test.mjs
git commit -m "feat: expose POST /update and the editable subtree on /servers"
```

---

### Task 5: Host 工具 — `mcp_manager_update`

**Files:**
- Modify: `lib/tools-bridge.js`
- Test: `test/plugin-tools.test.mjs`(追加), `test/tool-schema.test.mjs`(追加定点断言)

**Interfaces:**
- Consumes: `prepareUpdate` / `applyUpdate`(Task 3)
- Produces: 工具 `mcp_manager_update`,参数 `{ id, config, confirm, file }`;`createToolDefs(patchPath, { probe })` 新增可注入探测(与 `createRoutes` 的既有 seam 对称),`index.js` 的调用不变

- [ ] **Step 1: 写失败测试**

`test/plugin-tools.test.mjs`:顶部 import 补 `fs`(`node:fs`)与 `os`(`node:os`);**先改既有第 10-17 行的工具清单断言**(7 → 8 个,加入 `mcp_manager_update`):

```js
test('exports official Host form and eight manager tools', () => {
  assert.equal(name, 'dsh-mcp-manager');
  assert.deepEqual(inject, ['tools']);
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  assert.deepEqual(defs.map(d => d.name).sort(), [
    'mcp_manager_add', 'mcp_manager_credential', 'mcp_manager_list',
    'mcp_manager_probe', 'mcp_manager_remove', 'mcp_manager_toggle',
    'mcp_manager_update', 'mcp_manager_validate',
  ]);
  for (const d of defs) {
    assert.equal(typeof d.execute, 'function');
    assert.ok(d.parameters && typeof d.parameters === 'object' && d.parameters.type === 'object');
    assert.equal(typeof d.output.render, 'function');
    const rendered = d.output.render({}, { text: 'x' });
    assert.deepEqual(rendered, [{ type: 'text', text: 'x' }]);
  }
});
```

然后追加:

```js
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
```

`test/tool-schema.test.mjs` 追加:

```js
test('mcp_manager_update declares id/config as strings and confirm as a boolean', () => {
  const def = createToolDefs('x').find((d) => d.name === 'mcp_manager_update');
  assert.deepEqual(def.parameters.required, undefined);            // 与既有工具一致:必填靠 execute 内校验
  assert.equal(def.parameters.properties.id.type, 'string');
  assert.equal(def.parameters.properties.config.type, 'string');
  assert.equal(def.parameters.properties.confirm.type, 'boolean');
  assert.equal(def.parameters.additionalProperties, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/plugin-tools.test.mjs test/tool-schema.test.mjs`
Expected: FAIL — 工具数 7、`update` 为 undefined。

- [ ] **Step 3: 实现**

`lib/tools-bridge.js` 三处改动:

1. 顶部 import 加 `import { prepareUpdate, applyUpdate } from './update.js';`。
2. 签名加可注入探测(与 `createRoutes(ctx, { patchPath, probe })` 的既有 seam 对称,`index.js` 的 `createToolDefs(patchPath)` 调用不受影响):

```js
export function createToolDefs(patchPath = defaultPatchPath(), { probe = probeConfig } = {}) {
```

并把 `mcp_manager_add` 里那处 `const pr = await probeConfig(entry.config, { timeoutMs: 60000 });` 改成 `const pr = await probe(entry.config, { timeoutMs: 60000 });`。

3. 在 `mcp_manager_add` 之后插入:

```js
    def(
      'mcp_manager_update',
      "Replace one entry's config subtree with YAML text. Dry-run by default (returns the normalized text plus the official-rule and secret checks); confirm:true writes it through the guarded pipeline (candidate -> loader -> rules -> atomic write with a .bak) and probes the result. Unlike the browser panel, this tool may write !!js expressions — it is the same trust level as editing the patch file by hand.",
      {
        id: { type: 'string', description: 'Entry id, e.g. mcp-github' },
        config: { type: 'string', description: 'The new config subtree as YAML (the lines under `config:`)' },
        confirm: { type: 'boolean', description: 'Write the change when true; default dry-run' },
        file: { type: 'string', description: 'Optional patch file path' },
      },
      async (args) => {
        if (!args.id) throw new Error('id is required');
        if (typeof args.config !== 'string') throw new Error('config is required');
        const file = args.file ?? patchPath;
        const prep = await prepareUpdate({ file, id: args.id, fragment: args.config, allowJsExpr: true });
        if (!prep.ok) return `FAIL ${prep.code}:\n${prep.errors.join('\n')}`;
        const head = [];
        if (prep.introducedJsExpr > 0) head.push(`note: this change adds ${prep.introducedJsExpr} new !!js expression(s) — they are evaluated by the harness Loader at runtime`);
        if (prep.warnings.length) head.push(...prep.warnings.map((w) => `warn: ${w}`));
        if (!args.confirm) {
          return [...head, '--- DRY RUN, nothing written ---', prep.normalized, 'confirm:true writes this change.'].join('\n');
        }
        const r = await applyUpdate({ file, id: args.id, fragment: args.config, allowJsExpr: true });
        const { entries } = await loadPatchStructured(file);
        const entry = entries.find((e) => e.id === args.id);
        const pr = await probe(entry?.config ?? {}, { timeoutMs: 60000 });
        return [...head, `updated ${args.id} (backup: ${r.backupPath})`,
          pr.ok ? `probe OK: ${pr.toolCount} tools` : `probe FAIL: ${pr.error}`].join('\n');
      },
    ),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/plugin-tools.test.mjs test/tool-schema.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/tools-bridge.js test/plugin-tools.test.mjs test/tool-schema.test.mjs
git commit -m "feat: add the mcp_manager_update tool"
```

---

### Task 6: CLI — `show` 与 `edit`

**Files:**
- Modify: `cli/mcp.js`
- Test: `test/cli.test.mjs`(追加)

**Interfaces:**
- Consumes: `readConfigBlock`(Task 1)、`prepareUpdate` / `applyUpdate`(Task 3)
- Produces: `node cli/mcp.js show <id> [--json] [--masked]`;`node cli/mcp.js edit <id> [--config <file>] [--yes]`

- [ ] **Step 1: 写失败测试**

在 `test/cli.test.mjs` 追加。该文件的 `run(args)` 返回 `spawnSync` 结果,所以用 **`.status`**(不是 `.code`)判退出码;`sample` 是只读 fixture,写操作一律先 `fs.copyFileSync` 到临时副本(沿用既有 `tmp-work.yml` 的写法):

```js
test('show prints the subtree verbatim so it can be piped back', () => {
  const r = run(['show', 'mcp-gamma', '--file', sample]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.ok(r.stdout.includes("GAMMA_TOKEN: !!js require('fs')"),
    'verbatim: a masked value piped back into `edit` would silently corrupt the entry');
  assert.ok(!r.stdout.includes('config:'), 'the subtree only, not the config: line');
});

test('show --masked and --json', () => {
  const masked = run(['show', 'mcp-gamma', '--masked', '--file', sample]);
  assert.ok(masked.stdout.includes('GAMMA_TOKEN: !!js «0»'));
  assert.ok(!masked.stdout.includes('readFileSync'));
  const j = JSON.parse(run(['show', 'mcp-gamma', '--json', '--file', sample]).stdout);
  assert.equal(j.id, 'mcp-gamma');
  assert.equal(j.kind, 'block');
  assert.equal(j.indent, 4);
});

test('show fails for an unknown id', () => {
  const r = run(['show', 'nope', '--file', sample]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /entry not found: nope/);
});

test('edit dry-runs and only writes with --yes', () => {
  const copy = path.join(dir, 'tmp-edit-work.yml');
  const cfg = path.join(dir, 'tmp-edit-config.yml');
  fs.copyFileSync(sample, copy);
  fs.writeFileSync(cfg, 'serverName: gamma\ntransport: stdio\ncommand: node\ntoolCallTimeoutMs: 90000\n');
  try {
    const dry = run(['edit', 'mcp-gamma', '--config', cfg, '--file', copy]);
    assert.equal(dry.status, 0, dry.stderr || dry.stdout);
    assert.ok(dry.stdout.includes('DRY RUN'));
    assert.ok(!fs.readFileSync(copy, 'utf8').includes('toolCallTimeoutMs'));

    const wet = run(['edit', 'mcp-gamma', '--config', cfg, '--yes', '--file', copy]);
    assert.equal(wet.status, 0, wet.stderr || wet.stdout);
    assert.match(wet.stdout, /updated mcp-gamma/);
    const text = fs.readFileSync(copy, 'utf8');
    assert.ok(text.includes('toolCallTimeoutMs: 90000'));
    assert.ok(text.includes('mcp-alpha') && text.includes('mcp-beta'), 'siblings untouched');
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(cfg, { force: true });
  }
});

test('edit refuses a hardcoded secret', () => {
  const copy = path.join(dir, 'tmp-edit-secret.yml');
  const cfg = path.join(dir, 'tmp-edit-secret-config.yml');
  fs.copyFileSync(sample, copy);
  fs.writeFileSync(cfg, 'serverName: gamma\ntransport: streamable-http\nurl: https://x/mcp\nheaders:\n  Authorization: Bearer abc\n');
  try {
    const r = run(['edit', 'mcp-gamma', '--config', cfg, '--yes', '--file', copy]);
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /FAIL hardcoded_secret/);
    assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(sample, 'utf8'), 'the live file is untouched');
  } finally {
    fs.rmSync(copy, { force: true });
    fs.rmSync(cfg, { force: true });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — `unknown command: show`。

- [ ] **Step 3: 实现**

`cli/mcp.js`:`usage()` 的文本块加入两行;`readEntries()` 之后新增分支;`--config` / `--masked` 加入 flag 解析。

```js
  show <id> [--json] [--masked]          print one entry's config subtree (verbatim by default)
  edit <id> [--config <file>] [--yes]    replace the subtree from a file or stdin (dry-run without --yes)
```

```js
  else if (argv[i] === '--config') flags.config = argv[++i];
  else if (argv[i] === '--masked') flags.masked = true;
```

命令实现(放在 `add` 分支附近):

```js
async function cmdShow() {
  const id = rest[0];
  if (!id) usage();
  const text = fs.readFileSync(FILE, 'utf8');
  const block = readConfigBlock(text, id);
  if (!block) { console.error(`entry not found: ${id}`); process.exit(1); }
  const view = flags.masked ? toPanelView(block.configText) : { configText: block.configText };
  // Verbatim by default: a masked value piped back into `edit` would silently
  // corrupt the entry, so masking is opt-in and never the round-trip default.
  if (flags.json) console.log(JSON.stringify({ id, kind: block.kind, indent: block.indent, config: view.configText }));
  else console.log(view.configText);
}

async function cmdEdit() {
  const id = rest[0];
  if (!id) usage();
  const fragment = flags.config ? fs.readFileSync(flags.config, 'utf8') : fs.readFileSync(0, 'utf8');
  const prep = await prepareUpdate({ file: FILE, id, fragment, allowJsExpr: true });
  if (!prep.ok) { console.error(`FAIL ${prep.code}:\n${prep.errors.join('\n')}`); process.exit(1); }
  if (prep.introducedJsExpr > 0) console.error(`note: this change adds ${prep.introducedJsExpr} new !!js expression(s)`);
  if (!flags.yes) {
    console.log('--- DRY RUN, nothing written ---');
    console.log(prep.normalized);
    console.log('--yes writes this change.');
    return;
  }
  const r = await applyUpdate({ file: FILE, id, fragment, allowJsExpr: true });
  console.log(`updated ${id} (backup: ${r.backupPath})`);
}
```

分发处加入 `else if (cmd === 'show') await cmdShow();` 与 `else if (cmd === 'edit') await cmdEdit();`,import 加 `readConfigBlock`(from `../lib/surgery.js`,该文件已 import 过该模块)与 `prepareUpdate, applyUpdate, toPanelView`(from `../lib/update.js`),以及 `import fs from 'node:fs';`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/cli.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add cli/mcp.js test/cli.test.mjs
git commit -m "feat: add the show and edit CLI commands"
```

---

### Task 7: 面板 — 每行「编辑」

**Files:**
- Modify: `client.js`
- Test: `test/client.test.mjs`(追加)

**Interfaces:**
- Consumes: `GET /servers` 的 `configText` / `jsExprs` / `editable` / `editReason` / `mtimeMs`(Task 4)、`POST /update`(Task 4)
- Produces: `__test` 新增 `hasRawJsExpr(text) → boolean`、`openEditor(server) → { id, text, editable, reason }`

- [ ] **Step 1: 写失败测试**

`test/client.test.mjs` 追加。该文件把 `client.js` 放进 `vm` 沙箱加载,所以要走 `loadModule().factory(requireStub).__test`;又因为沙箱里的对象字面量原型与宿主不同(见既有测试第 61-62 行的注释),**不要对返回的对象用 `deepEqual`**,逐字段断言:

```js
test('hasRawJsExpr spots an expression the panel must not send back', () => {
  const { __test } = loadModule().factory(requireStub);
  assert.equal(__test.hasRawJsExpr('Authorization: !!js «0»'), false);
  assert.equal(__test.hasRawJsExpr('X: !!js process.env.HOME'), true);
  assert.equal(__test.hasRawJsExpr('serverName: x'), false);
  assert.equal(__test.hasRawJsExpr(undefined), false);
});

test('openEditor refuses a row the host marked uneditable', () => {
  const { __test } = loadModule().factory(requireStub);

  const refused = __test.openEditor({ id: 'mcp-github', configText: 'x', jsExprs: [], editable: false, editReason: 'hardcoded secret' });
  assert.equal(refused.id, '');
  assert.equal(refused.text, '');
  assert.equal(refused.editable, false);
  assert.equal(refused.reason, 'hardcoded secret');

  const seed = __test.openEditor({ id: 'mcp-gamma', configText: 'serverName: gamma', jsExprs: ['credential file: C:/x'], editable: true, editReason: '' });
  assert.equal(seed.id, 'mcp-gamma');
  assert.equal(seed.text, 'serverName: gamma');
  assert.equal(seed.editable, true);
  assert.equal(seed.reason, '');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/client.test.mjs`
Expected: FAIL — `hasRawJsExpr is not a function`。

- [ ] **Step 3: 实现**

`client.js` 的 `ZH`/`EN` 字典各加:

```js
      edit: '编辑',
      editLabel: '编辑 {id} 的配置',
      validate: '校验并预览',
      write: '写入',
      jsPlaceholders: '占位符（由服务端回填，面板不可修改）：{items}',
      editConflict: '文件已被外部修改，请重新加载后再改',
      reload: '重新加载',
```

```js
      edit: 'Edit',
      editLabel: 'Edit the config of {id}',
      validate: 'Validate',
      write: 'Write',
      jsPlaceholders: 'Placeholders (refilled by the host, not editable here): {items}',
      editConflict: 'The file changed on disk — reload before editing',
      reload: 'Reload',
```

纯函数(放在 `errorMessage` 之后):

```js
    /** True when the text carries a !!js expression that is not a placeholder. */
    function hasRawJsExpr(text) {
      return String(text ?? '').split('\n').some((l) => /!!js/.test(l) && !/!!js\s*«\d+»\s*$/.test(l));
    }

    /** Editor seed for one row; an uneditable row yields an empty, disabled seed. */
    function openEditor(server) {
      if (!server?.editable) return { id: '', text: '', editable: false, reason: server?.editReason ?? '' };
      return { id: server.id, text: server.configText ?? '', editable: true, reason: '' };
    }
```

`PanelBody` 新增状态:

```js
      const [editing, setEditing] = React.useState('');
      const [editText, setEditText] = React.useState('');
      const [editState, setEditState] = React.useState(null);
```

新增动作(放在 `runRemove` 之后):

```js
      function startEdit(server) {
        const seed = openEditor(server);
        if (!seed.editable) return;
        setEditing(seed.id);
        setEditText(seed.text);
        setEditState(null);
        setConfirming('');
      }

      function stopEdit() {
        setEditing('');
        setEditText('');
        setEditState(null);
      }

      async function runEdit(confirm) {
        setEditState(null);
        if (hasRawJsExpr(editText)) {
          setEditState({ errors: [t('jsPlaceholders', { items: '' })] });
          return;
        }
        setBusyKey('__edit', confirm ? 'write' : 'validate');
        try {
          const payload = await post('/update', {
            id: editing, config: editText, confirm,
            expectMtime: state.status === 'ready' ? state.data?.mtimeMs : undefined,
          });
          setEditState({ preview: payload.preview, warnings: payload.warnings ?? [] });
          if (confirm) { stopEdit(); await load(); await runProbe(editing); }
        } catch (e) {
          const msg = String(e?.message || e);
          const conflict = /file_changed|FileChangedExternally/.test(msg);
          setEditState({ errors: [conflict ? t('editConflict') : msg], conflict });
        } finally {
          setBusyKey('__edit', '');
        }
      }
```

行内动作组加入编辑按钮(在「探测」之前):

```js
                h('button', {
                  type: 'button', className: 'dsh-mcp-button',
                  disabled: isBusy || !s.editable,
                  title: s.editable ? t('editLabel', { id: s.id }) : s.editReason,
                  onClick: () => startEdit(s),
                }, t('edit')),
```

行内编辑区(紧跟在 `dsh-mcp-target` 那行之后):

```js
            editing === s.id
              ? h('div', { className: 'dsh-mcp-edit' },
                  h('textarea', {
                    className: 'dsh-mcp-input', value: editText,
                    onChange: (e) => setEditText(e.target.value),
                  }),
                  (s.jsExprs ?? []).length
                    ? h('div', { className: 'dsh-mcp-meta' }, t('jsPlaceholders', { items: s.jsExprs.join('; ') }))
                    : null,
                  h('div', { className: 'dsh-mcp-actions' },
                    h('button', { type: 'button', className: 'dsh-mcp-button', disabled: Boolean(busy.__edit),
                      onClick: () => runEdit(false) }, t('validate')),
                    h('button', { type: 'button', className: 'dsh-mcp-button', disabled: Boolean(busy.__edit),
                      onClick: () => runEdit(true) }, t('write')),
                    h('button', { type: 'button', className: 'dsh-mcp-button', onClick: stopEdit }, t('cancel'))),
                  (editState?.errors ?? []).map((x, i) => h('div', { key: `e${i}`, className: 'dsh-mcp-error' }, x)),
                  editState?.conflict
                    ? h('div', { className: 'dsh-mcp-actions' },
                        h('button', { type: 'button', className: 'dsh-mcp-button',
                          onClick: () => { stopEdit(); load(); } }, t('reload')))
                    : null,
                  editState?.preview ? h('div', { className: 'dsh-mcp-preview' }, editState.preview) : null)
              : null,
```

CSS 加一行:

```css
.dsh-mcp-edit { display: flex; flex-direction: column; gap: 8px; }
```

`__test` 导出加 `hasRawJsExpr, openEditor`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/client.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add client.js test/client.test.mjs
git commit -m "feat: edit a server's config from the panel"
```

---

### Task 8: 文档、版本与安装态验证

**Files:**
- Modify: `README.md`(面板段落、工具表、CLI 表)、`package.json`(0.3.0 → 0.4.0)、`assets/skills/dsh-mcp-manager/SKILL.md` 与 `~/.dsh/skills/dsh-mcp-manager/SKILL.md`
- Create: `docs/records/2026-10-13-edit-config-e2e.md`
- Test: `test/check-bundle.test.mjs`(既有,须保持绿)

**Interfaces:**
- Consumes: 前七个任务的产物
- Produces: 版本 0.4.0 的仓库与安装态

- [ ] **Step 1: 改 README**

面板段落里删掉 *"The panel deliberately does **not** edit arbitrary config fields or rotate credentials — those stay in the CLI and the agent tools."*,改为说明编辑能力与 `!!js` 边界(面板只见占位符,表达式只能由 CLI/工具改;凭据轮换仍在 CLI/工具)。工具表加一行 `mcp_manager_update`;CLI 代码块加 `show` 与 `edit` 两行;`## What it writes` 段落补一句:编辑走同一条候选 → loader → 原子写管线。

- [ ] **Step 2: 同步技能文件**

`assets/skills/dsh-mcp-manager/SKILL.md` 与 `~/.dsh/skills/dsh-mcp-manager/SKILL.md` 的 Workflow 加一步:"改配置 → `mcp_manager_update`(先干跑看校验结果,再 `confirm:true`);面板只认 `!!js «k»` 占位符,表达式改动必须走 CLI/工具"。

- [ ] **Step 3: 版本号与全量自检**

`package.json` 的 `version` 改为 `0.4.0`。

Run: `node --test "test/*.test.mjs"`
Expected: PASS(全量)。

Run: `node -e "import('./scripts/check-bundle.mjs').then(m => console.log(m.checkBundle('.')))"`
Expected: `{ ok: true, errors: [], warnings: [] }`。

- [ ] **Step 4: 同步安装态并重启验证**

```powershell
# 安装态是 pnpm 硬链接;改完仓库文件后核对两边一致
$a = "C:\Users\20157\daily_work\dsh-mcp-manager"
$b = "C:\Users\20157\.dsh\profiles\desktop\node_modules\@dsh-contrib\dsh-mcp-manager"
foreach ($f in 'lib\surgery.js','lib\update.js','lib\patchfile.js','lib\server.js','lib\tools-bridge.js','cli\mcp.js','client.js','package.json') {
  if (-not (Test-Path "$b\$f")) { Copy-Item "$a\$f" "$b\$f"; continue }
  if ((Get-FileHash "$a\$f").Hash -ne (Get-FileHash "$b\$f").Hash) { Copy-Item "$a\$f" "$b\$f" -Force }
}
```

`node_modules` 不在 DSH 的 HMR 监听范围(`docs/records/2026-10-13-tool-schema-503.md` 第 81 行),所以 `lib/`、`index.js`、`cli/` 的改动**需重启 DSH**;`client.js` 先试刷新页面。

重启后实测并记录:① 面板出现「编辑」;② 改 `mcp-chrome-devtools` 的 `toolCallTimeoutMs` 并写入 → 探测报工具数;③ `mcp-github` 的 `Authorization` 在面板里是 `!!js «0»` 占位符,写入后该行**逐字节不变**;④ `mcp_manager_update` 干跑与 `confirm:true`;⑤ CLI `show` / `edit` 干跑与 `--yes`。

- [ ] **Step 5: 写实测记录**

`docs/records/2026-10-13-edit-config-e2e.md`:照 `docs/records/2026-10-12-e2e-install.md` 的表格体例,逐项写"步骤 / 结果",失败的写清现象与根因;末尾写"待验证"清单。

- [ ] **Step 6: Commit 并打 tag**

```bash
git add README.md package.json assets/skills/dsh-mcp-manager/SKILL.md docs/records/2026-10-13-edit-config-e2e.md
git commit -m "docs: 0.4.0 config editing"
git tag v0.4.0
```

---

## 附:验证命令速查

```sh
node --test test/surgery.test.mjs
node --test test/update.test.mjs
node --test "test/*.test.mjs"
node -e "import('./scripts/check-bundle.mjs').then(m => console.log(m.checkBundle('.')))"
node cli/mcp.js show mcp-github
node cli/mcp.js edit mcp-github --config new-config.yml
```
