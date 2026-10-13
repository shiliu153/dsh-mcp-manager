#!/usr/bin/env node
// dsh-mcp CLI: manage MCP servers registered in a DSH cordis.patch.yml.
// Usage: node cli/mcp.js <list|probe|add|show|edit|remove|enable|disable|credential|validate|schema> [...]
//   --file <path>   operate on this patch file (default: $DSH_HOME/cordis.patch.yml or ~/.dsh/cordis.patch.yml)
//   --json          machine-readable output (list, show)
//   --yes           skip confirmation (add, edit, remove, enable, disable)
//   --timeout <s>   probe timeout in seconds (default 60)
//   --id <id>       probe a single entry
//   --config <path> edit: read the new config subtree from this file (default: stdin)
//   --masked        show: replace !!js expressions with placeholders
// Exit codes: 0 ok, 1 failure, 2 usage error.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseTopBlocks, findRow, readConfigBlock } from '../lib/surgery.js';
import { validateEntry, SERVER_NAME_RE } from '../lib/rules.js';
import { isMcpClientRow, maskEntry } from '../lib/rows.js';
import { loadPatchStructured } from '../lib/dump.js';
import { probeConfig } from '../lib/probe.js';
import { defaultPatchPath, renderEntryRow, applySurgery, applySurgeryAsync } from '../lib/patchfile.js';
import { prepareUpdate, applyUpdate, toPanelView } from '../lib/update.js';
import { resolveInput } from '../lib/resolve.js';

function usage() {
  console.error(`usage: mcp.js <command> [args]
  list [--json]                        list mcp-client entries (masked)
  probe [--id <id>] [--timeout <s>]    real handshake against each/one entry
  add <input> [--yes]                  resolve npm/github/url/json input into an entry
  show <id> [--json] [--masked]        print one entry's config subtree (verbatim by default)
  edit <id> [--config <file>] [--yes]  replace the subtree from a file or stdin (dry-run without --yes)
  remove <id> [--yes]                  remove an entry
  enable <id> [--yes] / disable <id> [--yes]
  credential <id> get|set <value>      rotate the credential file referenced by !!js
  validate <id>                        validate an existing entry against official rules
  schema                               print the official mcp-client field rules
common flags: --file <path>, --json, --yes, --timeout <s>`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--file') flags.file = argv[++i];
  else if (argv[i] === '--json') flags.json = true;
  else if (argv[i] === '--yes') flags.yes = true;
  else if (argv[i] === '--timeout') flags.timeout = Number(argv[++i]);
  else if (argv[i] === '--id') flags.id = argv[++i];
  else if (argv[i] === '--config') flags.config = argv[++i];
  else if (argv[i] === '--masked') flags.masked = true;
  else if (argv[i] === '--no-probe') flags.noProbe = true;
  else rest.push(argv[i]);
}
if (!cmd) usage();

const FILE = flags.file ?? defaultPatchPath();

async function readEntries() {
  try {
    const { entries } = await loadPatchStructured(FILE);
    return entries;
  } catch (e) {
    // Fallback: structural parse (no !!js evaluation) when the loader bridge is unavailable.
    const fs = await import('node:fs');
    const text = fs.readFileSync(FILE, 'utf8');
    const entries = [];
    for (const b of parseTopBlocks(text)) {
      if (b.kind === 'bare') entries.push({ id: b.id, name: nameOf(text, b.startLine), disabled: disabledOf(text, b.startLine, b.endLine), config: {} });
      else for (const r of b.rows) entries.push({ id: r.id, name: nameOf(text, r.startLine), disabled: disabledOf(text, r.startLine, r.endLine), config: {} });
    }
    console.error(`[warn] structured read failed (${e.message}); using structural parse without config detail`);
    return entries;
  }
}
function nameOf(text, line) { return /^ *name:\s*(.+)$/m.exec(text.split('\n').slice(line, line + 12).join('\n'))?.[1]?.replace(/^['"]|['"],?$/g, '') ?? ''; }
function disabledOf(text, a, b) { return /disabled:\s*true/.test(text.split('\n').slice(a, b + 1).join('\n')); }

switch (cmd) {
  case 'list': {
    const entries = (await readEntries()).filter(isMcpClientRow);
    const masked = entries.map(maskEntry);
    if (flags.json) { console.log(JSON.stringify({ file: FILE, entries: masked }, null, 2)); break; }
    console.log(`patch: ${FILE}`);
    console.log('id'.padEnd(24), 'server'.padEnd(18), 'transport'.padEnd(16), 'command/url'.padEnd(40), 'disabled');
    for (const e of masked) {
      const c = e.config ?? {};
      console.log(
        String(e.id).padEnd(24),
        String(c.serverName ?? '').padEnd(18),
        String(c.transport ?? '').padEnd(16),
        String(c.command ?? c.url ?? '').padEnd(40),
        e.disabled ? 'yes' : '',
      );
    }
    break;
  }
  case 'probe': {
    const entries = await readEntries();
    const targets = flags.id ? entries.filter(e => e.id === flags.id) : entries.filter(e => e.config?.transport);
    if (flags.id && targets.length === 0) { console.error(`entry not found: ${flags.id}`); process.exit(1); }
    let failures = 0;
    for (const e of targets) {
      const r = await probeConfig(e.config, { timeoutMs: (flags.timeout ?? 60) * 1000 });
      const label = `${e.id} (${e.config?.transport})`;
      if (r.ok) console.log(`OK    ${label}: ${r.toolCount} tools${r.tools.length ? ' — ' + r.tools.join(', ') : ''}`);
      else { failures++; console.log(`FAIL  ${label}: ${r.error}${r.detail ? ' | ' + r.detail.trim().slice(0, 200) : ''}`); }
    }
    process.exit(failures ? 1 : 0);
    break;
  }
  case 'add': {
    const input = rest[0];
    if (!input) usage();
    const { entry, warnings, notes, needsInput } = await resolveInput(input);
    for (const n of notes) console.log(`note: ${n}`);
    for (const w of warnings) console.log(`warn: ${w}`);
    if (needsInput?.length) { for (const n of needsInput) console.log(`needs input: ${n}`); process.exit(1); }
    const row = renderEntryRow(entry);
    console.log('--- entry to be written ---');
    console.log([`- id: ${row.id}`, `  name: '${row.name}'`, ...row.configLines.map(l => l)].join('\n'));
    if (!flags.yes) {
      console.log('--- dry run: nothing written. Re-run with --yes to write. ---');
      break;
    }
    const r = await applySurgeryAsync({ file: FILE, operation: { type: 'appendEntry', row } });
    console.log(`written (backup: ${r.backupPath})`);
    if (flags.noProbe) break;
    console.log('probing...');
    const pr = await probeConfig(entry.config, { timeoutMs: (flags.timeout ?? 60) * 1000 });
    console.log(pr.ok ? `probe OK: ${pr.toolCount} tools` : `probe FAIL: ${pr.error}`);
    process.exit(pr.ok ? 0 : 1);
    break;
  }
  case 'show': {
    const id = rest[0];
    if (!id) usage();
    const text = fs.readFileSync(FILE, 'utf8');
    const block = readConfigBlock(text, id);
    if (!block) { console.error(`entry not found: ${id}`); process.exit(1); }
    // Verbatim by default: a masked value piped back into `edit` would silently
    // corrupt the entry, so masking is opt-in and never the round-trip default.
    const configText = flags.masked ? toPanelView(block.configText).configText : block.configText;
    if (flags.json) console.log(JSON.stringify({ id, kind: block.kind, indent: block.indent, config: configText }));
    else console.log(configText);
    break;
  }
  case 'edit': {
    const id = rest[0];
    if (!id) usage();
    const fragment = flags.config ? fs.readFileSync(flags.config, 'utf8') : fs.readFileSync(0, 'utf8');
    let prep;
    try {
      // The CLI is a trusted local surface, like the agent tool: raw !!js text
      // is allowed here, exactly as if the patch file were edited by hand.
      prep = await prepareUpdate({ file: FILE, id, fragment, allowJsExpr: true });
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
    if (!prep.ok) { console.error(`FAIL ${prep.code}:\n${prep.errors.join('\n')}`); process.exit(1); }
    if (prep.introducedJsExpr > 0) console.error(`note: this change adds ${prep.introducedJsExpr} new !!js expression(s) — the harness Loader evaluates them at runtime`);
    for (const w of prep.warnings) console.error(`warn: ${w}`);
    if (!flags.yes) {
      console.log('--- DRY RUN, nothing written ---');
      console.log(prep.normalized);
      console.log('--yes writes this change.');
      break;
    }
    const r = await applyUpdate({ file: FILE, id, fragment, allowJsExpr: true });
    console.log(`updated ${id} (backup: ${r.backupPath})`);
    break;
  }
  case 'remove': {
    const id = rest[0];
    if (!id) usage();
    if (!flags.yes) { console.error('refusing to remove without --yes'); process.exit(1); }
    const r = await applySurgeryAsync({ file: FILE, operation: { type: 'remove', id } });
    console.log(`removed ${id} (backup: ${r.backupPath})`);
    break;
  }
  case 'enable':
  case 'disable': {
    const id = rest[0];
    if (!id) usage();
    if (!flags.yes) { console.error(`refusing to ${cmd} without --yes`); process.exit(1); }
    const r = await applySurgeryAsync({ file: FILE, operation: { type: 'setDisabled', id, value: cmd === 'disable' } });
    console.log(`${cmd}d ${id} (backup: ${r.backupPath})`);
    break;
  }
  case 'validate': {
    const id = rest[0];
    if (!id) usage();
    const entries = await readEntries();
    const e = entries.find(x => x.id === id);
    if (!e) { console.error(`entry not found: ${id}`); process.exit(1); }
    const r = validateEntry(e.config ?? {});
    if (r.ok) { console.log(`OK: ${id} satisfies official mcp-client rules`); for (const w of r.warnings) console.log(`warn: ${w}`); }
    else { for (const er of r.errors) console.error(`error: ${er}`); process.exit(1); }
    break;
  }
  case 'credential': {
    const id = rest[0];
    const op = rest[1];
    if (!id || !op || !['get', 'set'].includes(op)) usage();
    const fs = await import('node:fs');
    const text = fs.readFileSync(FILE, 'utf8');
    const row = findRow(text, id);
    if (!row) { console.error(`entry not found: ${id}`); process.exit(1); }
    const block = text.split('\n').slice(row.startLine, row.endLine + 1).join('\n');
    const m = /readFileSync\(\s*['"]([^'"]+)['"]/.exec(block);
    if (!m) { console.error(`entry ${id} does not reference a credential file via !!js readFileSync`); process.exit(1); }
    const credPath = m[1].replace(/^~(?=\/|$)/, (await import('node:os')).homedir());
    if (op === 'get') {
      const val = fs.readFileSync(credPath, 'utf8').trim();
      console.log(`${credPath}: B***** (length ${val.length})`);
    } else {
      const value = rest[2];
      if (!value) usage();
      fs.writeFileSync(credPath, value, { flag: 'w' });
      // touch the patch file to trigger config HMR re-evaluation of !!js
      const now = new Date();
      fs.utimesSync(FILE, now, now);
      console.log(`credential written to ${credPath}; patch file touched for reload`);
    }
    break;
  }
  case 'schema': {
    console.log(`official @deepseek-ai/dsh-mcp-client entry rules (from its README):
  serverName        required; /^[A-Za-z0-9_-]{1,32}$/; unique per registration scope
  transport         required; "stdio" | "streamable-http"
  stdio:            command (required), args[], env{}, cwd
  streamable-http:  url (required, http/https), headers{}
  toolCallTimeoutMs default 60000
  maxInstructionBytes default 32768
  failOnStartupError  default false (recommended true for freshly added servers)
  reconnect:        enabled(true) initialDelayMs(500) maxDelayMs(30000) maxAttempts(10)
  secrets:          never hardcode; store in a credential file and reference via !!js, e.g.
                      env:
                        GITHUB_TOKEN: !!js require('fs').readFileSync('C:/path/token.txt','utf8').trim()
  env scrubbing:    the harness drops ambient KEY/PASSWORD/SECRET/TOKEN-named and DSH_* vars from
                    its own environment; explicit env entries in config DO reach the stdio child.
`);
    break;
  }
  default:
    usage();
}
