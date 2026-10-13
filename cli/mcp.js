#!/usr/bin/env node
// dsh-mcp CLI: manage MCP servers registered in a DSH cordis.patch.yml.
// Usage: node cli/mcp.js <list|probe|search|install|add|show|edit|remove|enable|disable|credential|validate|schema> [...]
//   --file <path>   operate on this patch file (default: $DSH_HOME/cordis.patch.yml or ~/.dsh/cordis.patch.yml)
//   --json          machine-readable output (list, show, search)
//   --yes           skip confirmation (add, install, edit, remove, enable, disable)
//   --timeout <s>   probe timeout in seconds (default 60)
//   --id <id>       probe a single entry
//   --config <path> edit: read the new config subtree from this file (default: stdin)
//   --masked        show: replace !!js expressions with placeholders
//   --registry-base <url>  search/install: override the MCP registry base URL
// Exit codes: 0 ok, 1 failure, 2 usage error.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseTopBlocks, findRow, readConfigBlock, renderInsertBlock } from '../lib/surgery.js';
import { validateEntry, SERVER_NAME_RE } from '../lib/rules.js';
import { isMcpClientRow, maskEntry } from '../lib/rows.js';
import { loadPatchStructured } from '../lib/dump.js';
import { probeConfig } from '../lib/probe.js';
import { defaultPatchPath, renderEntryRow, applySurgery, applySurgeryAsync, readBackEntry, appendEntryGate } from '../lib/patchfile.js';
import { prepareUpdate, applyUpdate, toPanelView } from '../lib/update.js';
import { resolveInput } from '../lib/resolve.js';
import { searchServers, getServer } from '../lib/registry.js';
import { toEntry, findInstalled, driftOf, candidateForRegistry, rankByRelevance } from '../lib/market.js';
import { detectRuntimes } from '../lib/subprocess.js';

function usage() {
  console.error(`usage: mcp.js <command> [args]
  list [--json]                        list mcp-client entries (masked)
  probe [--id <id>] [--timeout <s>]    real handshake against each/one entry
  add <input> [--yes]                  resolve npm/github/url/json input into an entry
  search <query> [--limit N] [--cursor C]   search the official MCP Registry (names only)
  install <registry-name> [--yes]      install a registry entry (dry-run without --yes)
  show <id> [--json] [--masked]        print one entry's config subtree (verbatim by default)
  edit <id> [--config <file>] [--yes]  replace the subtree from a file or stdin (dry-run without --yes)
  remove <id> [--yes]                  remove an entry
  enable <id> [--yes] / disable <id> [--yes]
  credential <id> get|set <value>      rotate the credential file referenced by !!js
  validate <id>                        validate an existing entry against official rules
  schema                               print the official mcp-client field rules
common flags: --file <path>, --json, --yes, --timeout <s>, --registry-base <url>`);
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
  else if (argv[i] === '--limit') flags.limit = Number(argv[++i]);
  else if (argv[i] === '--cursor') flags.cursor = argv[++i];
  else if (argv[i] === '--version') flags.version = argv[++i];
  else if (argv[i] === '--registry-base') flags.registryBase = argv[++i];
  else rest.push(argv[i]);
}
if (!cmd) usage();

const FILE = flags.file ?? defaultPatchPath();
// undefined -> lib/registry.js falls back to the official registry.
const REGISTRY_BASE = flags.registryBase ?? undefined;

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

const executionLine = (exec) => (exec.kind === 'stdio'
  ? [exec.command, ...(exec.args ?? [])].join(' ')
  : exec.url);

/** Installed rows, plus the market's candidate for one registry entry. */
async function marketCandidate(name) {
  const installed = (await readEntries()).filter(isMcpClientRow);
  const got = await getServer({ name, version: flags.version ?? 'latest', baseUrl: REGISTRY_BASE });
  if (!got.server) throw new Error(got.error ?? `registry entry not found: ${name}`);
  const candidate = candidateForRegistry(got.server, installed, detectRuntimes());
  if (!candidate.ok) throw new Error(`not installable: ${candidate.reason}`);
  return { candidate, installed };
}

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
      else {
        failures++;
        console.log(`FAIL  ${label}: ${r.error}`);
        if (r.hint) console.log(`  hint: ${r.hint}`);
        if (r.detail) for (const l of r.detail.split('\n')) console.log(`  | ${l}`);
      }
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
    console.log(renderInsertBlock(row).join('\n'));
    if (!flags.yes) {
      console.log('--- dry run: nothing written. Re-run with --yes to write. ---');
      break;
    }
    let r;
    try {
      r = await applySurgeryAsync({
        file: FILE,
        operation: { type: 'appendEntry', row },
        preCommit: appendEntryGate({ id: row.id, serverName: entry.config.serverName }),
      });
    } catch (e) {
      // Unlike `edit`, the add path rejects during the write (the gate needs the
      // rendered candidate), so report the refusal instead of letting the throw
      // reach the top level as a stack dump.
      console.error(`FAIL ${String(e.message || e)}`);
      process.exit(1);
    }
    console.log(`written (backup: ${r.backupPath})`);
    if (flags.noProbe) break;
    // Verify what landed, never the object we just built.
    const back = await readBackEntry(FILE, row.id);
    if (!back.ok) { console.error(`verify FAIL: ${back.error}`); process.exit(1); }
    console.log('probing...');
    const pr = await probeConfig(back.config, { timeoutMs: (flags.timeout ?? 60) * 1000 });
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
  case 'search': {
    const query = rest[0];
    if (!query) usage();
    const installed = (await readEntries()).filter(isMcpClientRow);
    const r = await searchServers({
      query, limit: flags.limit ?? 20, cursor: flags.cursor, baseUrl: REGISTRY_BASE,
    });
    if (r.degraded) { console.error(`registry unreachable: ${r.degraded}`); process.exit(1); }
    const runtimeProbe = detectRuntimes();
    // Same local re-rank the panel route does: the registry matches names only,
    // so `anki` also returns every `banking-*` entry.
    const rows = rankByRelevance(
      r.servers
        .map((raw) => candidateForRegistry(raw?.server ?? raw, installed, runtimeProbe))
        .filter((c) => c.ok)
        .map((c) => ({
          c,
          registryName: c.provenance.registryName,
          title: c.provenance.title,
          description: c.provenance.description,
        })),
      query,
    ).map((x) => x.c);
    if (flags.json) {
      console.log(JSON.stringify({
        nextCursor: r.nextCursor ?? null,
        results: rows.map((c) => ({
          registryName: c.provenance.registryName,
          version: c.provenance.version,
          publisher: c.provenance.publisher,
          serverName: c.serverName,
          transport: c.execution.kind,
          runs: executionLine(c.execution),
          gaps: c.gaps,
          installed: Boolean(findInstalled(c, installed)),
        })),
      }, null, 2));
      break;
    }
    if (!rows.length) {
      console.log(`no installable registry entries matched "${query}" (unsupported transports and package types are filtered out)`);
      break;
    }
    for (const c of rows) {
      const already = findInstalled(c, installed);
      const drift = driftOf(c, already);
      console.log(`${c.provenance.registryName}@${c.provenance.version}  [${c.provenance.publisher}]`);
      console.log(`  ${c.provenance.title || c.provenance.description}`);
      console.log(`  serverName: ${c.serverName}`);
      console.log(`  runs: ${executionLine(c.execution)}`);
      if (c.execution.runtimePresent === false) console.log('  warn: the runtime for this package is not on PATH');
      if (c.gaps.length) console.log(`  needs credentials: ${c.gaps.map((g) => g.name).join(', ')}`);
      if (already) console.log(`  installed as ${already.id}${drift ? ` (${drift.state})` : ''}`);
      console.log('');
    }
    if (r.nextCursor) console.log(`cursor: ${r.nextCursor}`);
    break;
  }
  case 'install': {
    const name = rest[0];
    if (!name) usage();
    let resolved;
    try {
      resolved = await marketCandidate(name);
    } catch (e) {
      console.error(String(e.message || e));
      process.exit(1);
    }
    const { candidate: c, installed } = resolved;
    const already = findInstalled(c, installed);
    const drift = driftOf(c, already);
    console.log(`registry: ${c.provenance.registryName}@${c.provenance.version} (publisher ${c.provenance.publisher})`);
    if (c.provenance.repositoryUrl) console.log(`repo:     ${c.provenance.repositoryUrl}`);
    console.log(`runs:     ${executionLine(c.execution)}`);
    if (c.execution.runtimePresent === false) console.log('warn: the runtime for this package is not on PATH');
    for (const g of c.gaps) console.log(`needs ${g.kind}: ${g.name}${g.description ? ` — ${g.description}` : ''}`);
    if (already) console.log(`note: already registered as ${already.id}${drift ? ` (${drift.state})` : ''}`);
    const row = renderEntryRow(toEntry(c));
    console.log('--- entry to be written ---');
    console.log(renderInsertBlock(row).join('\n'));
    if (!flags.yes) {
      console.log('--- dry run: nothing written. Re-run with --yes to write. ---');
      break;
    }
    let r;
    try {
      r = await applySurgeryAsync({
        file: FILE,
        operation: { type: 'appendEntry', row },
        preCommit: appendEntryGate({ id: row.id, serverName: c.entryConfig.serverName }),
      });
    } catch (e) {
      console.error(`FAIL ${String(e.message || e)}`);
      process.exit(1);
    }
    console.log(`written (backup: ${r.backupPath})`);
    if (flags.noProbe) break;
    const back = await readBackEntry(FILE, row.id);
    if (!back.ok) { console.error(`verify FAIL: ${back.error}`); process.exit(1); }
    console.log('probing...');
    const pr = await probeConfig(back.config, { timeoutMs: (flags.timeout ?? 60) * 1000 });
    console.log(pr.ok ? `probe OK: ${pr.toolCount} tools` : `probe FAIL: ${pr.error}`);
    process.exit(pr.ok ? 0 : 1);
    break;
  }
  default:
    usage();
}
