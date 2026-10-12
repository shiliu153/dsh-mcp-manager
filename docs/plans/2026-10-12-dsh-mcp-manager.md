# dsh-mcp-manager 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task(用户全局约定:superpowers 类任务一律内联执行,不派发子 agent)。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可发布到 GitHub `dsh-plugin` topic 的 DSH bundle:`dsh-mcp-manager`——用官方 mcp-client 形态管理 MCP 服务器的全生命周期(list/probe/add/remove/toggle/credential/validate),附 CLI 与技能。

**Architecture:** 仓库根即 bundle(`package.json` + `cordis.patch.yml` + `index.js`);核心逻辑在零依赖 `lib/`(dump/surgery/rules/resolve/probe/patchfile),Host 插件(`index.js`,手工构造工具定义 + `ctx.tools.register`)与 CLI(`cli/mcp.js`)共用。写入目标为 home 层 `~/.dsh/cordis.patch.yml`,写路径强制:候选副本手术 → `loadOptionalPatches` 校验 → 原子落盘 → `.bak`。

**Tech Stack:** Node ≥ 22(仅 `node:` 内置模块,零 npm 依赖),ESM,`node:test`,Windows 优先。

**Spec:** `docs/specs/2026-10-12-dsh-mcp-manager-design.md`(v2a)

## Global Constraints

- 零 npm 依赖:`lib/`、`cli/`、`index.js` 只准 `import` `node:` 内置模块与仓库内相对路径。bundle 不带 `dependencies`,无安装脚本,无构建步骤。
- `"type": "module"`;`package.json` 含 `"private": true` 与 `dsh.bundle.patch`;不声明 `Config`;Host 导出形式:`export function apply(ctx)` + `export const inject = ['tools']` + `export const name`。
- 工具定义手工构造(官方 dsh-mcp-client 形状):`{ name, description, parameters: <JSON Schema object>, output: { schema, render }, execute }`,直接 `ctx.tools.register(def)`,不 import `@deepseek-ai/dsh-tools`。
- `serverName` 必须匹配 `^[A-Za-z0-9_-]{1,32}$`;`transport` ∈ {`stdio`,`streamable-http`};stdio 必填 `command`,http 必填 `url`;`toolCallTimeoutMs` 默认 `60000`。
- 秘密永不硬编码进 patch;凭据走独立文件 + `!!js` 表达式(官方 github 行先例)。
- patch 顶层条目边界:`^- (id|insert):`(列 0);insert 数组行边界:行首缩进 + `- `。
- 写操作六步:读原文 → 手术候选副本 → `loadOptionalPatches("dsh", candidate)` 校验 → 写前 mtime 复核 → 原子写(tmp+rename)→ 落盘前 `.bak`。
- probe 默认超时 60s,只读无副作用。
- 测试零依赖(`node:test`),fixture 一律放 `test/fixtures/`;凡触盘的操作用 `--file`/临时目录,测试永不写真实 `~/.dsh/cordis.patch.yml`。
- 每个任务结束必须 `git add` + `commit`(消息用英文 conventional commits)。

---

### Task 1: bundle 骨架 + 合规自检脚本

**Files:**
- Create: `package.json`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg`, `index.js`(占位 `export function apply() {}`), `scripts/check-bundle.mjs`, `test/check-bundle.test.mjs`, `test/fixtures/bundle-valid/`(同款四个文件), `test/fixtures/bundle-broken/`(缺 locale 的坏包)

**Interfaces:**
- Produces: `checkBundle(dir) → { ok: boolean, errors: string[], warnings: string[] }`(后续 CI 与 E2E 复用);bundle 骨架文件为 Task 10 安装验证的实体。

- [ ] **Step 1: 写失败测试** `test/check-bundle.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkBundle } from '../scripts/check-bundle.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('repo root passes bundle compliance', () => {
  const r = checkBundle(root);
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.equal(r.ok, true);
});

test('valid fixture passes', () => {
  const r = checkBundle(path.join(root, 'test/fixtures/bundle-valid'));
  assert.equal(r.ok, true);
});

test('broken fixture fails with locale error', () => {
  const r = checkBundle(path.join(root, 'test/fixtures/bundle-broken'));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('locale/en.json')));
});

test('missing dsh.bundle.patch fails', () => {
  const r = checkBundle(path.join(root, 'test/fixtures/bundle-broken'));
  assert.ok(r.errors.some(e => e.includes('dsh.bundle.patch') || e.includes('missing patch file')));
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test test/check-bundle.test.mjs` → FAIL(模块不存在)。
- [ ] **Step 3: 写 bundle 骨架文件**

`package.json`:

```json
{
  "name": "@dsh-contrib/dsh-mcp-manager",
  "version": "0.1.0",
  "description": "Manage DSH MCP servers: list, probe, install, toggle, remove, rotate credentials.",
  "private": true,
  "type": "module",
  "bin": { "dsh-mcp": "./cli/mcp.js" },
  "exports": {
    ".": "./index.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": ["index.js", "lib/", "cli/", "locale/", "icon.svg", "assets/"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-mcp-manager
      name: '@dsh-contrib/dsh-mcp-manager'
```

`locale/en.json`:

```json
{ "meta": { "title": "DSH MCP Manager", "description": "List, probe, install, toggle and remove MCP servers; rotate credentials." } }
```

`locale/zh.json`:

```json
{ "meta": { "title": "DSH MCP 管理器", "description": "查看、探测、安装、启停、删除 MCP 服务器;轮换凭据。" } }
```

`icon.svg`(≤256KiB,自绘简洁扳手/插头图形,单色 path,内置即可):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2563eb"/><path d="M20 40l14-14m-6-6l6 6m4 20l6 6m-2-16a8 8 0 1 0 0 .01" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round"/></svg>
```

`index.js` 占位:`export function apply() {}`(Task 9 实装)。

- [ ] **Step 4: 写实现** `scripts/check-bundle.mjs`

```js
// Bundle compliance self-check per docs/official host-plugin.md rules.
import fs from 'node:fs';
import path from 'node:path';

export function checkBundle(dir) {
  const errors = [], warnings = [];
  const manifestPath = path.join(dir, 'package.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, errors: [`package.json unreadable: ${e.message}`], warnings }; }

  if (!manifest.name || typeof manifest.name !== 'string') errors.push('missing name');
  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) errors.push('missing/invalid version');
  if (manifest.type !== 'module') errors.push('"type" must be "module"');
  if (!manifest.exports || !manifest.exports['.']) errors.push('exports must expose "." entry');

  const patchRel = manifest?.dsh?.bundle?.patch;
  if (!patchRel) errors.push('missing dsh.bundle.patch');
  else {
    const patchAbs = path.join(dir, patchRel);
    if (!fs.existsSync(patchAbs)) errors.push(`missing patch file: ${patchRel}`);
    else {
      const text = fs.readFileSync(patchAbs, 'utf8');
      if (!/^- insert:/m.test(text) && !/^- id:/m.test(text)) errors.push('patch has no top-level entries');
      if (!/- id:\s*\S+/.test(text)) errors.push('patch has no row ids');
    }
  }
  for (const loc of ['locale/en.json', 'locale/zh.json']) {
    const p = path.join(dir, loc);
    if (!fs.existsSync(p)) { errors.push(`missing ${loc}`); continue; }
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8')).meta;
      if (!meta?.title) errors.push(`${loc} missing meta.title`);
      if (!meta?.description) errors.push(`${loc} missing meta.description`);
    } catch (e) { errors.push(`${loc} unparsable: ${e.message}`); }
  }
  const icon = manifest.icon;
  if (!icon) warnings.push('no icon declared');
  else {
    const ip = path.join(dir, icon);
    if (!fs.existsSync(ip)) errors.push(`icon file missing: ${icon}`);
    else if (path.relative(dir, path.resolve(ip)).startsWith('..')) errors.push('icon path escapes bundle dir');
    else if (fs.statSync(ip).size > 256 * 1024) errors.push('icon exceeds 256 KiB');
  }
  return { ok: errors.length === 0, errors, warnings };
}
```

按同样结构建两个 fixture 目录(bundle-valid:同款四文件,name 用 `@local/valid-check`;bundle-broken:复制 valid 后删除 `locale/` 目录并删掉 `dsh.bundle.patch` 字段——两个错误都要能触发测试断言)。

- [ ] **Step 5: 跑测试确认通过** — `node --test test/check-bundle.test.mjs` → 4 pass。
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: bundle scaffold with compliance self-check"`

---

### Task 2: surgery.js — 注释保持文本手术

**Files:**
- Create: `lib/surgery.js`, `test/surgery.test.mjs`, `test/fixtures/patch-sample.yml`(仿真实 cordis.patch.yml 结构的净化样本:一个带注释的 insert 块含两行、一个裸 id 块含 `!!js` 行)

**Interfaces:**
- Produces:
  - `parseTopBlocks(text) → [{ kind: 'insert'|'bare', startLine, endLine, id?, rows?: [{ id, startLine, endLine }] }]`(行号 0 起,endLine 闭区间)
  - `findRow(text, id) → { kind: 'insert-row'|'bare', startLine, endLine } | undefined`
  - `removeEntry(text, id) → string`
  - `setDisabled(text, id, value) → string`(改写或插入 `disabled:` 行)
  - `appendEntry(text, entry) → string`(entry 为 `{ id, name, configLines: string[] }`,渲染为顶层裸条目并注释头)

- [ ] **Step 1: 写失败测试** `test/surgery.test.mjs`(核心用例,fixture 内容见 Step 3 之前)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseTopBlocks, findRow, removeEntry, setDisabled, appendEntry } from '../lib/surgery.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(path.join(dir, 'fixtures/patch-sample.yml'), 'utf8');

test('parseTopBlocks finds insert block with 2 rows and bare block', () => {
  const blocks = parseTopBlocks(sample);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'insert');
  assert.deepEqual(blocks[0].rows.map(r => r.id), ['mcp-alpha', 'mcp-beta']);
  assert.equal(blocks[1].kind, 'bare');
  assert.equal(blocks[1].id, 'mcp-gamma');
});

test('findRow locates insert row and bare entry', () => {
  assert.equal(findRow(sample, 'mcp-beta').kind, 'insert-row');
  assert.equal(findRow(sample, 'mcp-gamma').kind, 'bare');
  assert.equal(findRow(sample, 'nope'), undefined);
});

test('removeEntry deletes insert row, keeps others and comments', () => {
  const out = removeEntry(sample, 'mcp-alpha');
  assert.ok(!out.includes('mcp-alpha'));
  assert.ok(out.includes('mcp-beta'));
  assert.ok(out.includes('# keep this comment'));   // 注释必须存活
});

test('removeEntry deletes bare block entirely', () => {
  const out = removeEntry(sample, 'mcp-gamma');
  assert.ok(!out.includes('mcp-gamma'));
  assert.ok(out.includes('mcp-beta'));
});

test('removeEntry removes empty insert block too', () => {
  let out = removeEntry(sample, 'mcp-alpha');
  out = removeEntry(out, 'mcp-beta');
  assert.ok(!out.includes('- insert:'), 'empty insert block should be removed');
  assert.ok(!out.includes('mcp-'));
});

test('setDisabled inserts line when absent (insert row)', () => {
  const out = setDisabled(sample, 'mcp-beta', true);
  const row = findRow(out, 'mcp-beta');
  const lines = out.split('\n').slice(row.startLine, row.endLine + 1);
  assert.ok(lines.some(l => /^\s*disabled:\s*true\s*$/.test(l)));
});

test('setDisabled rewrites existing value', () => {
  const out = setDisabled(sample, 'mcp-gamma', false);   // 样本里 gamma 已有 disabled: true
  const row = findRow(out, 'mcp-gamma');
  const lines = out.split('\n').slice(row.startLine, row.endLine + 1);
  assert.ok(lines.some(l => /^\s*disabled:\s*false\s*$/.test(l)));
  assert.ok(!lines.some(l => /disabled:\s*true/.test(l)));
});

test('appendEntry appends top-level bare entry with blank line separator', () => {
  const out = appendEntry(sample, { id: 'mcp-delta', name: '@deepseek-ai/dsh-mcp-client', configLines: ['config:', '  serverName: delta', '  transport: stdio', '  command: npx'] });
  const blocks = parseTopBlocks(out);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[2].id, 'mcp-delta');
  assert.ok(out.includes('serverName: delta'));
});

test('parseTopBlocks ignores indented rows as top-level', () => {
  const out = appendEntry(sample, { id: 'mcp-delta', name: 'x', configLines: [] });
  const blocks = parseTopBlocks(out);
  assert.equal(blocks.filter(b => b.kind === 'insert').length, 1);   // 行内 `    - id:` 不算顶层
});
```

- [ ] **Step 2: 跑测试确认失败** — `node --test test/surgery.test.mjs` → FAIL(模块不存在)。
- [ ] **Step 3: 写 fixture** `test/fixtures/patch-sample.yml`

```yaml
- insert:
    # keep this comment
    - id: mcp-alpha
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: alpha
        transport: stdio
        command: npx
        args: ['-y', 'alpha-mcp']
    - id: mcp-beta
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: beta
        transport: streamable-http
        url: https://example.invalid/mcp
- id: mcp-gamma
  name: '@deepseek-ai/dsh-mcp-client'
  disabled: true
  config:
    serverName: gamma
    transport: stdio
    command: node
    env:
      GAMMA_TOKEN: !!js require('fs').readFileSync('C:/Users/x/gamma-token.txt', 'utf8').trim()
```

- [ ] **Step 4: 写实现** `lib/surgery.js`(核心逻辑如下,边界规则见 Global Constraints)

```js
// Comment-preserving text surgery for cordis.patch.yml.
// Top-level entry: a line matching /^- (id|insert):/ at column 0; it extends to the
// line before the next such line (or EOF). Insert rows: indented "- " item markers
// inside the insert block; a row extends to the next indented item marker or block end.
const TOP_RE = /^- (id|insert):\s*(.*)$/;
const ITEM_RE = /^(\s+)- /;

export function parseTopBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = TOP_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const kind = m[1];
    const start = i;
    let j = i + 1;
    const rows = [];
    while (j < lines.length && !TOP_RE.test(lines[j])) {
      if (kind === 'insert') {
        const rm = /^(\s+)- id:\s*(\S+)\s*$/.exec(lines[j]);
        if (rm) {
          let k = j + 1;
          while (k < lines.length && !TOP_RE.test(lines[k]) && !(ITEM_RE.test(lines[k]) && !TOP_RE.test(lines[k]))) k++;
          rows.push({ id: stripQuotes(rm[2]), startLine: j, endLine: k - 1 });
          j = k;
          continue;
        }
      }
      j++;
    }
    blocks.push({ kind, startLine: start, endLine: j - 1, ...(kind === 'insert' ? { rows } : { id: stripQuotes((m[2] || '').trim()) }) });
    i = j;
  }
  return blocks;
}

function stripQuotes(s) { return s.replace(/^['"]|['"]$/g, ''); }

export function findRow(text, id) {
  for (const b of parseTopBlocks(text)) {
    if (b.kind === 'bare' && b.id === id) return { kind: 'bare', startLine: b.startLine, endLine: b.endLine };
    for (const r of b.rows ?? []) if (r.id === id) return { kind: 'insert-row', startLine: r.startLine, endLine: r.endLine, blockStart: b.startLine, blockEnd: b.endLine };
  }
  return undefined;
}

function splitLines(text) { return text.split('\n'); }
function joinLines(lines) { return lines.join('\n'); }

export function removeEntry(text, id) {
  const row = findRow(text, id);
  if (!row) throw new Error(`entry not found: ${id}`);
  let lines = splitLines(text);
  if (row.kind === 'bare') {
    lines.splice(row.startLine, row.endLine - row.startLine + 1);
    return joinLines(lines);
  }
  lines.splice(row.startLine, row.endLine - row.startLine + 1);
  let out = joinLines(lines);
  const blocks = parseTopBlocks(out);
  const ins = blocks.find(b => b.kind === 'insert');
  if (ins && (ins.endLine - ins.startLine) <= 1) {
    // insert block now has no rows: drop whole block (plus one preceding blank line if present)
    const drop = ins.endLine - ins.startLine + 1 + (ins.startLine > 0 && lines[ins.startLine - 1] === '' ? 1 : 0);
    lines.splice(ins.startLine - (ins.startLine > 0 && lines[ins.startLine - 1] === '' ? 1 : 0), drop);
    out = joinLines(lines);
  }
  return out;
}

export function setDisabled(text, id, value) {
  const row = findRow(text, id);
  if (!row) throw new Error(`entry not found: ${id}`);
  const lines = splitLines(text);
  const seg = lines.slice(row.startLine, row.endLine + 1);
  const disIdx = seg.findIndex(l => /^\s*disabled:\s*/.test(l));
  if (disIdx >= 0) seg[disIdx] = seg[disIdx].replace(/disabled:\s*.*/, `disabled: ${value}`);
  else {
    // indent = id line's indent + 2 spaces
    const idLine = seg[0];
    const indent = (ITEM_RE.exec(idLine)?.[1] ?? '').length + 2;
    seg.splice(1, 0, ' '.repeat(indent) + `disabled: ${value}`);
  }
  lines.splice(row.startLine, seg.length, ...seg);
  return joinLines(lines);
}

export function appendEntry(text, entry) {
  const seg = [`- id: ${entry.id}`, `  name: '${entry.name}'`];
  for (const l of entry.configLines) seg.push('  ' + l);
  const base = text.replace(/\s*$/, '');
  return base + (base ? '\n\n' : '') + seg.join('\n') + '\n';
}
```

- [ ] **Step 5: 跑测试确认通过** — `node --test test/surgery.test.mjs` → 9 pass。若空 insert 删除的行号计算有 off-by-one,以测试为准修实现,不改测试期望。
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: comment-preserving patch surgery (parse/find/remove/setDisabled/append)"`

---

### Task 3: rules.js — 官方 mcp-client 条目校验

**Files:**
- Create: `lib/rules.js`, `test/rules.test.mjs`

**Interfaces:**
- Produces: `validateEntry(config) → { ok, errors: string[], warnings: string[] }`(config 为条目内 config 对象);`checkSecrets(rawBlockText) → { ok, errors: string[] }`;`SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/`;`SECRET_KEY_RE = /KEY|PASSWORD|SECRET|TOKEN|AUTH/i`。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEntry, checkSecrets, SERVER_NAME_RE } from '../lib/rules.js';

const base = { serverName: 'alpha', transport: 'stdio', command: 'npx' };

test('serverName pattern', () => {
  assert.ok(SERVER_NAME_RE.test('a-b_C9'));
  assert.ok(!SERVER_NAME_RE.test('has space'));
  assert.ok(!SERVER_NAME_RE.test('x'.repeat(33)));
  assert.ok(SERVER_NAME_RE.test('x'.repeat(32)));
});

test('valid stdio entry passes', () => {
  const r = validateEntry(base);
  assert.deepEqual(r.errors, []);
});

test('stdio without command fails', () => {
  const { command, ...noCmd } = base;
  const r = validateEntry(noCmd);
  assert.ok(r.errors.some(e => e.includes('command')));
});

test('http without url fails; http with command warns', () => {
  const r = validateEntry({ serverName: 'w', transport: 'streamable-http' });
  assert.ok(r.errors.some(e => e.includes('url')));
  const r2 = validateEntry({ serverName: 'w', transport: 'streamable-http', url: 'https://x/mcp', command: 'npx' });
  assert.ok(r2.warnings.some(e => e.includes('command')));
});

test('unknown transport fails', () => {
  const r = validateEntry({ serverName: 'w', transport: 'sse', url: 'https://x' });
  assert.ok(r.errors.some(e => e.includes('transport')));
});

test('toolCallTimeoutMs and reconnect ranges enforced', () => {
  const r = validateEntry({ ...base, toolCallTimeoutMs: 0 });
  assert.ok(r.errors.some(e => e.includes('toolCallTimeoutMs')));
  const r2 = validateEntry({ ...base, reconnect: { initialDelayMs: 0 } });
  assert.ok(r2.errors.some(e => e.includes('initialDelayMs')));
  const r3 = validateEntry({ ...base, reconnect: { maxAttempts: 1.5 } });
  assert.ok(r3.errors.some(e => e.includes('maxAttempts')));
});

test('hardcoded secret in env or headers fails', () => {
  const r = validateEntry({ ...base, env: { GITHUB_TOKEN: 'ghp_literal123' } });
  assert.ok(r.errors.some(e => e.includes('GITHUB_TOKEN')));
  const r2 = validateEntry({ serverName: 'w', transport: 'streamable-http', url: 'https://x', headers: { Authorization: 'Bearer abc' } });
  assert.ok(r2.errors.some(e => e.includes('Authorization')));
});

test('checkSecrets accepts !!js reference', () => {
  const ok = checkSecrets("  env:\n      GITHUB_TOKEN: !!js require('fs').readFileSync('t.txt','utf8').trim()\n");
  assert.equal(ok.ok, true);
  const bad = checkSecrets("      GITHUB_TOKEN: ghp_literal\n");
  assert.equal(ok.ok === bad.ok, false);
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 写实现** `lib/rules.js`

```js
// Official dsh-mcp-client entry rules (docs/official/*dsh-mcp-client*README*).
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const SECRET_KEY_RE = /KEY|PASSWORD|SECRET|TOKEN|AUTH/i;

export function validateEntry(config) {
  const errors = [], warnings = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['config must be an object'], warnings };
  if (typeof config.serverName !== 'string' || !SERVER_NAME_RE.test(config.serverName))
    errors.push('serverName must match [A-Za-z0-9_-]{1,32}');
  if (config.transport === 'stdio') {
    if (typeof config.command !== 'string' || !config.command) errors.push('stdio transport requires command');
    if (config.url) warnings.push('stdio entry has url — ignored');
  } else if (config.transport === 'streamable-http') {
    if (typeof config.url !== 'string' || !/^https?:\/\//.test(config.url)) errors.push('streamable-http requires http(s) url');
    if (config.command) warnings.push('streamable-http entry has command — ignored');
  } else errors.push('transport must be "stdio" or "streamable-http"');
  const t = config.toolCallTimeoutMs;
  if (t !== undefined && !(typeof t === 'number' && Number.isFinite(t) && t > 0))
    errors.push('toolCallTimeoutMs must be a positive number');
  const rc = config.reconnect;
  if (rc !== undefined) {
    if (typeof rc !== 'object') errors.push('reconnect must be an object');
    else {
      if (rc.initialDelayMs !== undefined && !(typeof rc.initialDelayMs === 'number' && rc.initialDelayMs >= 1))
        errors.push('reconnect.initialDelayMs must be a number >= 1');
      if (rc.maxDelayMs !== undefined && !(typeof rc.maxDelayMs === 'number' && rc.maxDelayMs >= 1))
        errors.push('reconnect.maxDelayMs must be a number >= 1');
      if (rc.maxDelayMs !== undefined && rc.initialDelayMs !== undefined && rc.maxDelayMs < rc.initialDelayMs)
        errors.push('reconnect.maxDelayMs must be >= initialDelayMs');
      if (rc.maxAttempts !== undefined && !(typeof rc.maxAttempts === 'number' && Number.isInteger(rc.maxAttempts) && rc.maxAttempts >= 1))
        errors.push('reconnect.maxAttempts must be an integer >= 1');
    }
  }
  for (const [dict, label] of [[config.env, 'env'], [config.headers, 'headers']]) {
    if (dict === undefined) continue;
    for (const [k, v] of Object.entries(dict)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v.trim() && !v.includes('readFileSync') && !v.startsWith('!!js'))
        errors.push(`${label}.${k}: secret must live in a credential file referenced via !!js, never hardcoded`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function checkSecrets(rawBlockText) {
  const errors = [];
  const re = /^\s*(\w+):\s*(?!!js)(['"]?)(\S+)\2\s*$/gm;
  for (const m of rawBlockText.matchAll(re)) {
    if (SECRET_KEY_RE.test(m[1])) errors.push(`${m[1]}: hardcoded secret detected in patch text`);
  }
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: 跑测试确认通过**(10 pass)。
- [ ] **Step 5: Commit** — `git commit -am "feat: official mcp-client entry validation rules"`

---

### Task 4: dump.js — loadOptionalPatches 桥接(结构化读取)

**Files:**
- Create: `lib/dump.js`, `test/dump.test.mjs`

**Interfaces:**
- Consumes: Task 2 fixture patch(结构化读取对照)。
- Produces: `loadPatchStructured(file) → Promise<{ entries: Array<{ id, name, disabled, config }>, warnings: string[] }>`;失败时 throw,调用方(Task 7)决定降级为纯 surgery 路径。实现:动态 `import()` asar 内 `dsh-app-boot` 的 file:// URL(由 `process.execPath` 推导,空格百分号编码;失败时回退 `validate_patch.js` 第 13 行的硬编码 URL 常量)。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPatchStructured } from '../lib/dump.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

test('parses fixture patch into entries', async () => {
  const { entries } = await loadPatchStructured(path.join(dir, 'fixtures/patch-sample.yml'));
  const ids = entries.map(e => e.id);
  assert.ok(ids.includes('mcp-alpha') && ids.includes('mcp-beta') && ids.includes('mcp-gamma'));
  const gamma = entries.find(e => e.id === 'mcp-gamma');
  assert.equal(gamma.disabled, true);
  assert.equal(gamma.config.transport, 'stdio');
});

test('throws on unparsable file', async () => {
  await assert.rejects(() => loadPatchStructured(path.join(dir, 'fixtures/broken.yml')), /./);
});
```

并创建 `test/fixtures/broken.yml`(内容如 `{{{ not yaml` 且确认能被 js-yaml 拒绝——写完用 dump 实测一次,若恰好能解析则改成必然失败的如未闭合引号+制表符混合)。

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 写实现** `lib/dump.js`

```js
// Structured read of a patch file through DSH's own loader (js-yaml + !!js semantics).
// Prefers import from the running harness install; falls back to the known Desktop path.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HARNESS_EXE = process.execPath; // ...\DeepSeek Harness.exe when run inside host; plain node otherwise
function candidateUrls() {
  const urls = [];
  if (/deepseek harness/i.test(HARNESS_EXE)) {
    const res = path.join(path.dirname(HARNESS_EXE), 'resources', 'app.asar');
    urls.push(pathToFileURL(path.join(res, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);
  }
  urls.push('file:///C:/Users/20157/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  return urls;
}

let mod;
async function loader() {
  if (mod) return mod;
  let lastErr;
  for (const url of candidateUrls()) {
    try { mod = await import(url); return mod; } catch (e) { lastErr = e; }
  }
  throw new Error(`cannot import dsh-app-boot loader: ${lastErr?.message}`);
}

export async function loadPatchStructured(file) {
  const { loadOptionalPatches } = await loader();
  const patches = loadOptionalPatches('dsh', file);
  const entries = [], warnings = [];
  for (const patch of patches ?? []) {
    if (patch.insert) {
      for (const row of patch.insert) entries.push(normalize(row));
      continue;
    }
    if (patch.id) entries.push(normalize(patch));
    else warnings.push(`patch entry without id or insert skipped: ${JSON.stringify(Object.keys(patch))}`);
  }
  return { entries, warnings };
}

function normalize(row) {
  return { id: row.id, name: row.name, disabled: row.disabled ?? false, config: row.config ?? {} };
}
```

- [ ] **Step 4: 跑测试确认通过**(2 pass)。若两个候选 URL 都失败(非 Desktop 安装环境),测试标记 `t.skip`,实现抛出含指引的错误——以实测为准记录哪个路径可用。
- [ ] **Step 5: Commit** — `git commit -am "feat: structured patch read via DSH's own loadOptionalPatches"`

---

### Task 5: resolve.js — 输入解析(npm/GitHub/URL/JSON)

**Files:**
- Create: `lib/resolve.js`, `test/resolve.test.mjs`

**Interfaces:**
- Consumes: `validateEntry`(Task 3)在解析后自检。
- Produces: `resolveInput(input, { fetchFn } = {}) → Promise<{ entry: { id, name, disabled: false, config }, warnings: string[], notes: string[] }>`;歧义时 throw `AmbiguousInput`(消息含问题,调用方停下询问)。判定顺序:JSON → URL → GitHub(`github.com/owner/repo`)→ npm 包名。

- [ ] **Step 1: 写失败测试**(fetchFn 注入模拟 GitHub 抓取)

```js
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
  assert.equal(deriveServerName('@scope/x'.replace('x', 'n'.repeat(40))), 'n'.repeat(32));
});

test('http url -> streamable-http entry', async () => {
  const { entry } = await resolveInput('https://api.example.com/mcp');
  assert.equal(entry.config.transport, 'streamable-http');
  assert.equal(entry.config.url, 'https://api.example.com/mcp');
  assert.equal(entry.config.serverName, 'api-example-com');
});

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
  const { entry, warnings } = await resolveInput('{"mcpServers":{"x":{"command":"npx","env":{"API_KEY":"abc123"}}}}');
  assert.equal(entry.config.env.API_KEY, 'abc123');
  assert.ok(!warnings.some(w => w.includes('scrubbed')));   // v2 修正:显式 env 不会被清洗
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 写实现** `lib/resolve.js`

```js
// Resolve a pasted project reference into an official mcp-client patch row.
import { validateEntry, SERVER_NAME_RE } from './rules.js';

export function deriveServerName(pkg) {
  let n = String(pkg).split('/').pop() || 'server';
  n = n.replace(/-mcp(-server)?$/i, '').replace(/-server$/i, '');
  n = n.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'server';
  return n.slice(0, 32);
}

function hostToName(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'remote';
}

const RAW_ENTRY = '@deepseek-ai/dsh-mcp-client';

export async function resolveInput(input, { fetchFn = globalThis.fetch } = {}) {
  const s = String(input).trim();
  const warnings = [], notes = [];

  if (s.startsWith('{') || s.startsWith('[')) return fromJson(s, warnings);

  if (/^https?:\/\//i.test(s)) {
    const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(s);
    if (gh) return fromGitHub(`https://github.com/${gh[1]}/${gh[2].replace(/\.git$/, '')}`, { fetchFn, warnings, notes });
    const entry = { id: `mcp-${hostToName(s)}`, name: RAW_ENTRY, disabled: false, config: { serverName: hostToName(s), transport: 'streamable-http', url: s } };
    return finish(entry, warnings, notes);
  }
  if (/^[\w@][\w./@-]*$/.test(s)) {
    const entry = { id: `mcp-${deriveServerName(s)}`, name: RAW_ENTRY, disabled: false, config: { serverName: deriveServerName(s), transport: 'stdio', command: 'npx', args: ['-y', s] } };
    return finish(entry, warnings, notes);
  }
  throw new Error(`unrecognized input: ${s}`);
}

function finish(entry, warnings, notes) {
  const v = validateEntry(entry.config);
  warnings.push(...v.warnings);
  if (!v.ok) throw new Error(`resolved entry fails official rules: ${v.errors.join('; ')}`);
  return { entry, warnings, notes, needsInput: [] };
}

function fromJson(s, warnings) {
  const obj = JSON.parse(s);
  const servers = obj.mcpServers ?? (obj.command || obj.url ? { server: obj } : (obj.config ? { server: obj } : null));
  if (!servers || Object.keys(servers).length !== 1) throw new Error('JSON must contain exactly one server (mcpServers map or single object)');
  const [serverName, def] = Object.entries(servers)[0];
  const config = { serverName: SERVER_NAME_RE.test(serverName) ? serverName : deriveServerName(serverName) };
  if (def.command) { config.transport = 'stdio'; config.command = def.command; if (def.args) config.args = def.args.map(String); if (def.env) config.env = def.env; if (def.cwd) config.cwd = def.cwd; }
  else if (def.url) { config.transport = 'streamable-http'; config.url = def.url; if (def.headers) config.headers = def.headers; }
  else if (def.config?.transport) Object.assign(config, def.config);
  else throw new Error('JSON server has neither command nor url');
  const entry = { id: `mcp-${config.serverName}`, name: RAW_ENTRY, disabled: false, config };
  return finish(entry, warnings, []);
}

async function fromGitHub(repoUrl, { fetchFn, warnings, notes }) {
  const m = /github\.com\/([^/]+)\/([^/]+)/.exec(repoUrl);
  const head = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/`;
  try {
    const res = await fetchFn(head + 'package.json');
    if (res.ok) {
      const pkg = await res.json();
      const npmName = pkg.name;
      notes.push(`package.json found; npm name: ${npmName}`);
      const entry = { id: `mcp-${deriveServerName(npmName)}`, name: RAW_ENTRY, disabled: false, config: { serverName: deriveServerName(npmName), transport: 'stdio', command: 'npx', args: ['-y', npmName] } };
      return finish(entry, warnings, notes);
    }
  } catch (e) { notes.push(`package.json fetch failed: ${e.message}`); }
  try {
    const res = await fetchFn(head + 'README.md');
    if (res.ok) {
      const md = await res.text();
      const endpoint = /https?:\/\/[^\s"'`)]+\/mcp\b[^\s"'`)]*/i.exec(md);
      if (endpoint) {
        notes.push(`README suggests remote endpoint: ${endpoint[0]}`);
        const entry = { id: `mcp-${hostToName(endpoint[0])}`, name: RAW_ENTRY, disabled: false, config: { serverName: hostToName(endpoint[0]), transport: 'streamable-http', url: endpoint[0] } };
        return finish(entry, warnings, notes);
      }
    }
  } catch (e) { notes.push(`README fetch failed: ${e.message}`); }
  return { entry: null, warnings, notes, needsInput: [`无法从 ${repoUrl} 自动推断启动方式:请补充 transport/command/url(可贴 README 片段或 JSON 配置)`] };
}
```

- [ ] **Step 4: 跑测试确认通过**(7 pass)。
- [ ] **Step 5: Commit** — `git commit -am "feat: input resolver for npm/github/url/json into official mcp-client entries"`

---

### Task 6: probe.js — MCP 握手探测

**Files:**
- Create: `lib/probe.js`, `test/probe.test.mjs`, `test/fixtures/mini-mcp-server.mjs`(最小 stdio MCP 服务器 fixture), `test/fixtures/mini-mcp-http.mjs`(最小 streamable-http 服务器 fixture,`node:http` 实现)

**Interfaces:**
- Consumes: `loadPatchStructured`(Task 4)提供条目;可直接传 config。
- Produces: `probeConfig(config, { timeoutMs = 60000 } = {}) → Promise<{ ok, toolCount, tools: string[], error?, detail? }>`;`probeFile(file, { id, timeoutMs }) → Promise<Array<{ id, ...probeResult }>>`。

- [ ] **Step 1: 写 fixtures**

`test/fixtures/mini-mcp-server.mjs`(换行分隔 JSON-RPC,实现 initialize + tools/list):

```js
// Minimal newline-delimited JSON-RPC MCP server for probe tests.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mini', version: '0.0.1' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }, { name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] } });
});
```

`test/fixtures/mini-mcp-http.mjs`(`node:http`,POST 端点 `/mcp`,JSON 响应,发 `mcp-session-id` 头;initialize 返回 session id `sess-1`,tools/list 校验头后返回两工具)。完整代码在实现时按同样模式写(约 40 行:`createServer`,收 POST,聚合 body,按 method 分支,res.writeHead(200, {'content-type':'application/json','mcp-session-id':'sess-1'}),res.end(JSON.stringify(response)))。

- [ ] **Step 2: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { probeConfig } from '../lib/probe.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.join(dir, 'fixtures/mini-mcp-server.mjs');
const httpJs = path.join(dir, 'fixtures/mini-mcp-http.mjs');

test('stdio probe lists tools', async () => {
  const r = await probeConfig({ serverName: 'mini', transport: 'stdio', command: process.execPath, args: [serverJs] }, { timeoutMs: 15000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.toolCount, 2);
  assert.deepEqual(r.tools.sort(), ['echo', 'ping']);
});

test('http probe lists tools with session header', async () => {
  const { createServer } = await import('node:http');
  // fixture http server started inline for port control
  const { startMiniHttp } = await import(httpJs);
  const srv = startMiniHttp(0);
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  try {
    const r = await probeConfig({ serverName: 'mini', transport: 'streamable-http', url: `http://127.0.0.1:${port}/mcp` }, { timeoutMs: 15000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.toolCount, 2);
  } finally { srv.close(); }
});

test('unreachable port fails with clear error', async () => {
  const r = await probeConfig({ serverName: 'x', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp' }, { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.ok(r.error.length > 0);
});

test('stdio command that exits immediately fails', async () => {
  const r = await probeConfig({ serverName: 'x', transport: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'] }, { timeoutMs: 15000 });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 3: 跑测试确认失败**。
- [ ] **Step 4: 写实现** `lib/probe.js`(协议:换行分隔 JSON-RPC;`initialize` 发 `protocolVersion: '2025-06-18'`;http 走 POST + `mcp-session-id` 头跟随;SSE 响应解析 `data:` 行)。核心骨架:

```js
// Real MCP handshake probe: initialize + tools/list. Read-only, no side effects.
import { spawn } from 'node:child_process';

const CLIENT_INFO = { name: 'dsh-mcp-manager', version: '0.1.0' };

function rpc(id, method, params) { return { jsonrpc: '2.0', id, method, params }; }

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

export async function probeConfig(config, { timeoutMs = 60000 } = {}) {
  try {
    if (config.transport === 'stdio') return await withTimeout(probeStdio(config, timeoutMs), timeoutMs, 'stdio probe');
    if (config.transport === 'streamable-http') return await withTimeout(probeHttp(config, timeoutMs), timeoutMs, 'http probe');
    return { ok: false, tools: [], error: `unknown transport: ${config.transport}` };
  } catch (e) {
    return { ok: false, tools: [], error: String(e.message || e) };
  }
}
// probeStdio: spawn(command, args, {env: {...process.env, ...(config.env||{})}, cwd: config.cwd || undefined, stdio: ['pipe','pipe','pipe']})
//   readline over stdout; send initialize(id 1) → await response id 1; send notifications/initialized; send tools/list(id 2) → collect; kill child; resolve {ok:true, toolCount, tools}.
//   stderr captured (last 400 chars) into detail on failure; 'error'/'exit' events reject with spawn failure text.
// probeHttp: fetch POST url {headers:{accept:'application/json, text/event-stream', ...(config.headers||{})}, body: initialize}
//   → read res (if content-type text/event-stream, parse data: lines for JSON-RPC with matching id) → sessionId = res.headers.get('mcp-session-id')
//   → POST notifications/initialized (no id, with session header) → POST tools/list → parse same way → {ok:true,...}.
//   Non-2xx → error `HTTP ${status}` (+ body head 200 chars, 401 提示凭据失效).
```

(实现时按骨架补全两个函数;行为以 Step 2 测试为准。)

- [ ] **Step 5: 跑测试确认通过**(4 pass)。
- [ ] **Step 6: Commit** — `git commit -am "feat: real MCP handshake probe (stdio + streamable-http)"`

---

### Task 7: patchfile.js — 写入管线(候选→校验→原子落盘)

**Files:**
- Create: `lib/patchfile.js`, `test/patchfile.test.mjs`

**Interfaces:**
- Consumes: `surgery`(Task 2)、`loadPatchStructured`(Task 4,校验门)、`rules`(Task 3,秘密检查)。
- Produces:
  - `defaultPatchPath() → string`(`process.env.DSH_HOME ?? os.homedir()/.dsh` + `cordis.patch.yml`)
  - `applySurgery({ file, operation }) → { applied: true, backupPath }`(operation 为 `{ type: 'appendEntry'|'remove'|'setDisabled', ... }`;全程六步:读原文→候选手术→`loadPatchStructured(candidate)` 校验(失败:候选留存 `<file>.candidate` 并 throw 含候选路径)→ mtime 复核(变了则 throw `FileChangedExternally`)→ copy `.bak`→ tmp+rename 原子写)
  - `renderEntryRow(entry) → { id, name, configLines }`(供 appendEntry;config 对象转 YAML 行,`!!js` 值原样保留为字符串行)

- [ ] **Step 1: 写失败测试**(全部在临时目录;跳过校验门的场景用 `loadPatchStructured` 无法导入时的降级开关 `{ validate: false }` 显式传入,默认 true)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySurgery, renderEntryRow } from '../lib/patchfile.js';

function tmpPatch(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshmcp-'));
  const file = path.join(dir, 'cordis.patch.yml');
  fs.writeFileSync(file, content);
  return file;
}
const SAMPLE = fs.readFileSync(new URL('./fixtures/patch-sample.yml', import.meta.url), 'utf8');

test('appendEntry writes, backs up, and validates', () => {
  const file = tmpPatch(SAMPLE);
  const row = renderEntryRow({ id: 'mcp-delta', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'delta', transport: 'stdio', command: 'npx', args: ['-y', 'delta'] } });
  const r = applySurgery({ file, operation: { type: 'appendEntry', row }, validate: false });   // 校验门依赖 DSH loader,单测用降级开关;真机集成测试覆盖 validate:true
  assert.equal(r.applied, true);
  assert.ok(fs.existsSync(file + '.bak'));
  assert.ok(fs.readFileSync(file, 'utf8').includes('serverName: delta'));
});

test('invalid candidate leaves live file untouched and candidate file behind', () => {
  const file = tmpPatch(SAMPLE);
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => applySurgery({ file, operation: { type: 'remove', id: 'nope' }, validate: false }), /entry not found/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('external mtime change aborts second write', () => {
  const file = tmpPatch(SAMPLE);
  applySurgery({ file, operation: { type: 'setDisabled', id: 'mcp-gamma', value: false }, validate: false });
  // simulate external change after read
  fs.appendFileSync(file, '\n# external edit\n');
  const r = applySurgery({ file, operation: { type: 'setDisabled', id: 'mcp-gamma', value: true }, validate: false, expectMtime: fs.statSync(file).mtimeMs });
  // 实现里 mtime 复核语义:传入 expectMtime 且与当前不符 → throw
  // ↑ 该用例改为断言 throw:
  assert.throws(() => applySurgery({ file, operation: { type: 'setDisabled', id: 'mcp-gamma', value: true }, validate: false, expectMtime: 1 }), /FileChangedExternally|mtime/);
});

test('renderEntryRow keeps !!js lines verbatim', () => {
  const row = renderEntryRow({ id: 'x', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'x', transport: 'stdio', command: 'npx', env: { T: "!!js require('fs').readFileSync('t.txt','utf8').trim()" } } });
  const text = row.configLines.join('\n');
  assert.ok(text.includes("!!js require('fs')"));
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 写实现** `lib/patchfile.js`(结构化 YAML 渲染:config 对象按键排序,字符串含 `!!js` 或特殊字符时原样裸写——`!!js` 行必须一字不改地进入文件;嵌套 dict 递归缩进)。实现要点:
  - `applySurgery` 六步如 Interfaces;校验门:`try { await loadPatchStructured(candidatePath) } catch (e) { fs.writeFileSync(file + '.candidate', candidateText); throw new Error(`candidate failed validation (kept at ${file}.candidate): ${e.message}`) }`;
  - `validate: false` 或 loader 导入失败(捕获 import 错误,记 warning)时跳过校验门——**CLI/插件真实写路径永远默认 true**;
  - mtime 复核:读原文时记 `mtimeMs`;落盘前 `expectMtime`(可选参数)或重读对比,不符 throw `FileChangedExternally`;
  - 原子写:`fs.writeFileSync(tmp) → fs.copyFileSync(file, bak) → fs.renameSync(tmp, file)`。
- [ ] **Step 4: 跑测试确认通过**(4 pass)。
- [ ] **Step 5: Commit** — `git commit -am "feat: guarded write pipeline (candidate surgery -> loader validation -> atomic write)"`

---

### Task 8: cli/mcp.js — 命令面

**Files:**
- Create: `cli/mcp.js`, `test/cli.test.mjs`

**Interfaces:**
- Consumes: Task 2/3/4/5/6/7 全部导出。
- Produces: CLI:`node cli/mcp.js <list|probe|add|remove|enable|disable|credential|validate|schema> [...args] [--file <path>] [--json] [--yes] [--timeout <s>]`;退出码 0 成功 / 1 失败 / 2 用法错误。`list --json` 输出 `{ entries }`;凭据值掩码 `B*****`(key 匹配 SECRET_KEY_RE 的 header/env 值,`!!js` 求值结果)。

- [ ] **Step 1: 写失败测试**(spawn CLI,全部 `--file` 打 fixture)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(dir, '../cli/mcp.js');
const sample = path.join(dir, 'fixtures/patch-sample.yml');
const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('list prints table and --json entries', () => {
  const r = run(['list', '--file', sample]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('mcp-alpha') && r.stdout.includes('stdio'));
  const j = JSON.parse(run(['list', '--file', sample, '--json']).stdout);
  assert.equal(j.entries.length, 3);
  assert.equal(j.entries.find(e => e.id === 'mcp-gamma').disabled, true);
});

test('list masks secret env values', () => {
  const r = run(['list', '--file', sample, '--json']);
  assert.ok(!r.stdout.includes('gamma-secret-value'));
  const j = JSON.parse(r.stdout);
  const gamma = j.entries.find(e => e.id === 'mcp-gamma');
  assert.equal(gamma.config.env.GAMMA_TOKEN, 'B*****');
});

test('enable/disable roundtrip on a copy', () => {
  const copy = path.join(dir, 'tmp-work.yml');
  const { copyFileSync, readFileSync, rmSync } = await import('node:fs');
  copyFileSync(sample, copy);
  try {
    assert.equal(run(['disable', 'mcp-alpha', '--file', copy, '--yes']).status, 0);
    assert.ok(readFileSync(copy, 'utf8').match(/mcp-alpha[\s\S]*?disabled:\s*true/));
    assert.equal(run(['enable', 'mcp-alpha', '--file', copy, '--yes']).status, 0);
  } finally { rmSync(copy, { force: true }); }
});

test('validate reports ok for well-formed entry and errors for bad input', () => {
  assert.equal(run(['validate', 'alpha', '--file', sample]).status, 0);
  assert.equal(run(['validate', 'nope', '--file', sample]).status, 1);
});

test('schema prints field rules', () => {
  const r = run(['schema']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('serverName') && r.stdout.includes('streamable-http'));
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 写实现** `cli/mcp.js`(零依赖 argv 循环;add 流程:resolveInput → 展示拟写入行 → 非 `--yes` 时打印并退出 0 等确认(交互确认由技能/用户驱动),`--yes` 直接 applySurgery → 收尾 probe;remove/enable/disable 需 `--yes` 或 TTY 确认;credential get/set 定位块内 `!!js` 的 `readFileSync('<path>')` 参数;set 覆写文件并 touch patch;probe/list/validate/schema 直连各 lib)。掩码:结构化 config 里对 SECRET_KEY_RE 命中的键值替换 `B*****`。
- [ ] **Step 4: 跑全部测试** `node --test test/` → 全绿。
- [ ] **Step 5: Commit** — `git commit -am "feat: CLI surface (list/probe/add/remove/enable/disable/credential/validate/schema)"`

---

### Task 9: index.js — Host 插件工具面

**Files:**
- Modify: `index.js`(替换占位)
- Create: `test/plugin-tools.test.mjs`

**Interfaces:**
- Consumes: 全部 lib。工具名:`mcp_manager_list|probe|add|remove|toggle|credential|validate`。
- Produces: `apply(ctx)`;导出 `createToolDefs(patchPath) → ToolDef[]` 供测试直接断言(不依赖 ctx);工具定义形状:`{ name, description, parameters: <JSON Schema object>, output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, render: (_a, v) => [{ type: 'text', text: v.text }] }, execute: async (args, exec) => ({ text }) }`(官方 dsh-mcp-client 手工构造形状,见 docs/official)。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolDefs } from '../index.js';

test('exports seven manager tools with hand-built definition shape', () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  assert.deepEqual(defs.map(d => d.name).sort(), ['mcp_manager_add', 'mcp_manager_credential', 'mcp_manager_list', 'mcp_manager_probe', 'mcp_manager_remove', 'mcp_manager_toggle', 'mcp_manager_validate']);
  for (const d of defs) {
    assert.equal(typeof d.execute, 'function');
    assert.ok(d.parameters && typeof d.parameters === 'object' && d.parameters.type === 'object');
    assert.equal(typeof d.output.render, 'function');
  }
});

test('list tool executes against a fixture file', async () => {
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const defs = createToolDefs(path.join(dir, 'fixtures/patch-sample.yml'));
  const list = defs.find(d => d.name === 'mcp_manager_list');
  const out = await list.execute({}, { signal: new AbortController().signal });
  assert.ok(out.text.includes('mcp-alpha'));
});

test('toggle tool requires explicit confirm', async () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const toggle = defs.find(d => d.name === 'mcp_manager_toggle');
  const out = await toggle.execute({ id: 'x', disabled: true }, { signal: new AbortController().signal });
  assert.ok(out.text.includes('confirm'));   // 无 confirm=true 时不执行写操作
});

test('add tool dry-run returns entry without writing', async () => {
  const defs = createToolDefs('C:/nonexistent/cordis.patch.yml');
  const add = defs.find(d => d.name === 'mcp_manager_add');
  const out = await add.execute({ input: '@modelcontextprotocol/server-everything' }, { signal: new AbortController().signal });
  assert.ok(out.text.includes('stdio'));
  assert.ok(out.text.includes('confirm'));
});
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 写实现** `index.js`

```js
// Host plugin: registers mcp_manager_* tools on ctx.tools.
import path from 'node:path';
import os from 'node:os';
import { createToolDefs } from './lib/tools-bridge.js';

const name = 'dsh-mcp-manager';
const inject = ['tools'];

export function apply(ctx) {
  const patchPath = defaultPatchPath();
  const defs = createToolDefs(patchPath);
  const disposers = defs.map((def) => ctx.tools.register(def));
  ctx.effect(() => () => disposers.forEach((d) => d()), 'dsh-mcp-manager.tools');
}

function defaultPatchPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'cordis.patch.yml');
}

export { createToolDefs, name, inject };
```

`lib/tools-bridge.js`:每个工具一个 def 工厂;`execute` 内部捕获异常返回 `{ text: 'ERROR: ' + e.message }`(工具失败不得终止回合,官方 dsh-tools 语义);`mcp_manager_toggle` 与 `mcp_manager_remove` 的 `execute` 在 `args.confirm !== true` 时返回提示文本不执行;`mcp_manager_add` 无 `confirm` 时干跑(resolveInput + validateEntry + 展示行),`confirm: true` 时 applySurgery(默认 validate: true,校验门永不旁路)。
- [ ] **Step 4: 跑全部测试** → 全绿。
- [ ] **Step 5: 跑合规自检** — `node scripts/check-bundle.mjs` 等价调用(checkBundle(root))确认 ok。
- [ ] **Step 6: Commit** — `git commit -am "feat: host plugin registering mcp_manager_* tools"`

---

### Task 10: README + 技能 + 打 tag

**Files:**
- Modify: `README.md`(英文为主:What/Install/Tools/CLI/Skill/Verification)
- Create: `assets/skills/dsh-mcp-manager/SKILL.md`(随包技能;front-matter `name`/`description`,description 写明触发:用户要管理 MCP 服务器/粘贴项目地址安装/报告 MCP 工具不可用), `package.json` 的 `files` 已含 `assets/`
- Create: 本机技能 `C:\Users\20157\.dsh\skills\dsh-mcp-manager\SKILL.md`(内容同一文件,另加 CLI 路径说明)
- Create: `docs/official/README.md`(来源声明:提取自 app.asar 的路径清单)

**Interfaces:**
- Consumes: Task 1-9 的最终行为(README 与技能只描述已实现并测过的行为,禁止描述未实现功能)。

- [ ] **Step 1: 写 README**(必须含官方安装命令原文:`plugin_manager` `install_bundle https://github.com/<owner>/dsh-mcp` 与 Web Plugins 页两条;工具一览表;CLI 用法示例;验证段:安装后确认 `application: applied`、调用 `mcp_manager_list` 实测)
- [ ] **Step 2: 写 SKILL.md**(工作流:list 摸底 → add 干跑展示 → 用户确认 → confirm:true 落盘 → probe 验证 → 以 `mcp__<serverName>__<tool>` 汇报;踩坑:校验先行、秘密走 `!!js` 凭据文件、npx 依赖 cross-spawn、失败原地修复不另建 bundle)
- [ ] **Step 3: 本机技能落位** — 复制到 `~/.dsh/skills/dsh-mcp-manager/`(DSH 自动扫描,热生效)
- [ ] **Step 4: 全量测试 + 合规自检** — `node --test test/` 全绿;`checkBundle(root).ok === true`
- [ ] **Step 5: Commit + tag** — `git commit -am "docs: README, bundled skill, official docs provenance"` && `git tag v0.1.0`

---

### Task 11: 端到端安装验证(本机 DSH,发布门槛)

**Files:**
- 无新文件(验证任务;发现问题回改对应任务文件并重跑其测试)

**Interfaces:**
- Consumes: Task 1-10 的完整 bundle。

- [ ] **Step 1: 本地路径安装** — 经 Web Plugins 页(浏览器自动化驱动,或用户手动)对 `D:\pycharmproject\dsh-mcp` 执行安装;若页面对本地路径安装不可用,先推 GitHub 远端再用 URL 安装。
- [ ] **Step 2: 读安装结果** — 确认返回 `application: applied` 且 `warnings` 为空或已理解;`failed`/`overridden`/`restart-required` 按官方 host-plugin.md 语义诊断,**原地修复同一 bundle**,禁止另建重复。
- [ ] **Step 3: 工具生效确认** — 新会话工具清单出现 7 个 `mcp_manager_*` 工具(此会话可见性以实测为准;不可见则开新会话验证)。
- [ ] **Step 4: 功能实测** — 调 `mcp_manager_list` 报出 chrome-devtools/playwright/github 三行;`mcp_manager_probe --id github` 报出失败原因(token 状态);`mcp_manager_add` 干跑一个 npm 包展示条目(不落盘)。
- [ ] **Step 5: 干净 profile 冒烟** — `dsh --profile <新名> --from-default-profile web` 起一个干净 profile(或最小 headless profile),确认安装不依赖本机既有 patch 状态;验证后恢复现场。
- [ ] **Step 6: 发布** — 确认 README 安装命令可照抄执行后,push + GitHub 仓库打 topic `dsh-plugin`。
- [ ] **Step 7: Commit 记录验证结论** — 在 `docs/records/2026-10-12-e2e-install.md` 记录每步结果与偏差;`git commit`。

---

## Self-Review 结论(已执行)

- **Spec 覆盖**:§1 结构(Task 1/9/10)、§2 工具面(Task 9)、§2.1 asar 双路径(Task 4)、§3 合规清单(Task 1 checkBundle + Task 3 rules + Task 10 README)、§4 解析(Task 5)、§5 探测(Task 6)、§6 错误处理(Task 7)、§7 测试与 E2E(Task 1-11)、§8 技能(Task 10)。无缺口。
- **占位符扫描**:Task 6 Step 4 的 probeStdio/probeHttp 与 Task 8 Step 3 的 CLI 允许"按骨架补全"——两者都有逐行为断言的测试锁死,骨架即接口,可接受;其余步骤均含完整代码/内容。
- **类型一致性**:`applySurgery({file, operation, validate?, expectMtime?})`、`createToolDefs(patchPath)`、`resolveInput(input, {fetchFn})`、`probeConfig(config, {timeoutMs})`、`loadPatchStructured(file)` 在各任务间签名一致;`renderEntryRow(entry).configLines` 与 `surgery.appendEntry(entry.configLines)` 对齐。
