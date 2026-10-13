// Bridge between the official tool-definition shape and the manager libs.
// Definitions follow the hand-built shape used by @deepseek-ai/dsh-mcp-client
// ({name, description, parameters, output:{schema,render}, execute}) and are
// registered directly via ctx.tools.register — no dsh-tools import needed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPatchStructured } from './dump.js';
import { renderInsertBlock } from './surgery.js';
import { probeConfig } from './probe.js';
import { resolveInput } from './resolve.js';
import { validateEntry } from './rules.js';
import { isMcpClientRow, maskEntry } from './rows.js';
import { defaultPatchPath, renderEntryRow, applySurgeryAsync, readBackEntry, appendEntryGate } from './patchfile.js';
import { prepareUpdate, applyUpdate } from './update.js';
import { searchServers, getServer } from './registry.js';
import { toEntry, findInstalled, driftOf, candidateForRegistry } from './market.js';
import { detectRuntimes } from './subprocess.js';

function ok(text) { return { text }; }
function err(e) { return { text: `ERROR: ${String(e?.message || e)}` }; }

async function readEntries(patchPath) {
  if (!fs.existsSync(patchPath)) throw new Error(`patch file not found: ${patchPath}`);
  const { entries } = await loadPatchStructured(patchPath);
  if (!entries || entries.length === 0) throw new Error(`no entries parsed from ${patchPath}`);
  return entries;
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

function def(name, description, properties, run) {
  const parameters = { type: 'object', properties, additionalProperties: false };
  return {
    name,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, v) => [{ type: 'text', text: v.text }] },
    execute: async (args, exec) => {
      try { return ok(await run(args, exec)); } catch (e) { return err(e); }
    },
  };
}

// `probe` is injectable for the same reason createRoutes() takes one: the write
// paths verify their result with a real handshake, which tests must stub.
// `search`/`get` are injectable so the market tools never reach the network in
// a test run.
export function createToolDefs(patchPath = defaultPatchPath(), {
  probe = probeConfig, search = searchServers, get = getServer,
} = {}) {
  /** Installed rows — the one thing every market call needs. */
  const installedContext = async (file) => (await readEntries(file).catch(() => [])).filter(isMcpClientRow);

  /** Human text for a drift record, shared by search and add. */
  const driftText = (drift) => {
    if (!drift) return '';
    switch (drift.state) {
      case 'behind': return `update available: ${drift.installed} -> ${drift.latest}`;
      case 'current': return 'up to date';
      case 'ahead': return `installed ${drift.installed} is newer than the registry's ${drift.latest}`;
      case 'unpinned': return 'installed without a pinned version, so it cannot be compared';
      default: return `installed ${drift.installed}, registry has ${drift.latest} (not comparable)`;
    }
  };

  const runsLine = (exec) => (exec.kind === 'stdio'
    ? [exec.command, ...(exec.args ?? [])].join(' ')
    : exec.url);

  /** One registry entry -> the same resolution-result shape resolveInput returns. */
  const resolveFromRegistry = async (name, file) => {
    const installed = await installedContext(file);
    const got = await get({ name });
    if (!got.server) throw new Error(got.error ?? `registry entry not found: ${name}`);
    const candidate = candidateForRegistry(got.server, installed, detectRuntimes());
    if (!candidate.ok) throw new Error(`not installable: ${candidate.reason}`);
    const already = findInstalled(candidate, installed);
    const drift = driftOf(candidate, already);
    return {
      entry: toEntry(candidate),
      warnings: candidate.gaps.map((g) => `needs ${g.kind} ${g.name}${g.description ? ` — ${g.description}` : ''}; fill it after the write with mcp_manager_credential`),
      notes: [
        `registry: ${candidate.provenance.registryName}@${candidate.provenance.version} (publisher ${candidate.provenance.publisher})`,
        `runs: ${runsLine(candidate.execution)}`,
        ...(already ? [`already registered as ${already.id}${drift ? ` — ${driftText(drift)}` : ''}`] : []),
      ],
      needsInput: [],
    };
  };

  return [
    def(
      'mcp_manager_list',
      'List MCP servers registered in the DSH patch file (id, transport, command/url, disabled). Credential values are masked.',
      { file: { type: 'string', description: 'Optional patch file path; defaults to the home cordis.patch.yml' } },
      async (args) => {
        const file = args.file ?? patchPath;
        const entries = await readEntries(file);
        if (!entries) return `patch unreadable via loader: ${file}`;
        const lines = [`patch: ${file}`];
        for (const e of entries.filter(isMcpClientRow).map(maskEntry)) {
          const c = e.config ?? {};
          lines.push(`${e.id} | ${c.serverName ?? ''} | ${c.transport ?? ''} | ${c.command ?? c.url ?? ''} | ${e.disabled ? 'disabled' : 'enabled'}`);
        }
        return lines.join('\n');
      },
    ),
    def(
      'mcp_manager_search',
      'Search the official MCP Registry for installable servers. Read-only. Returns, per hit: the registry name and publisher, the version, the exact command line or URL that would run, the credential variables still to be filled, whether an equivalent server is already registered, and any version drift. Note the registry matches NAMES only, so search by package or server name. Install a hit with mcp_manager_add using source:"registry".',
      {
        query: { type: 'string', description: 'Search text; the registry matches names only' },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
        cursor: { type: 'string', description: 'Pagination cursor returned by a previous call' },
        file: { type: 'string', description: 'Optional patch file path' },
      },
      async (args) => {
        if (!args.query) throw new Error('query is required');
        const file = args.file ?? patchPath;
        const installed = await installedContext(file);
        const limit = Math.min(50, Math.max(1, args.limit ?? 20));
        const r = await search({ query: args.query, limit, cursor: args.cursor });
        if (r.degraded) return `registry unreachable: ${r.degraded}`;
        if (!r.servers.length) return `no registry entries matched "${args.query}"`;
        const runtimeProbe = detectRuntimes();
        const blocks = [];
        for (const raw of r.servers) {
          const c = candidateForRegistry(raw?.server ?? raw, installed, runtimeProbe);
          if (!c.ok) continue;   // spec D6: unsupported entries are not offered
          const already = findInstalled(c, installed);
          const drift = driftOf(c, already);
          blocks.push([
            `${c.provenance.registryName}@${c.provenance.version}`,
            `  serverName: ${c.serverName}`,
            `  ${c.provenance.title || c.provenance.description}`,
            `  publisher: ${c.provenance.publisher}`,
            `  runs: ${runsLine(c.execution)}`,
            c.execution.runtimePresent === false ? '  warn: the runtime for this package is not on PATH' : '',
            c.gaps.length ? `  needs credentials: ${c.gaps.map((g) => g.name).join(', ')}` : '',
            already ? `  installed as ${already.id}${drift ? ` — ${driftText(drift)}` : ''}` : '',
          ].filter(Boolean).join('\n'));
        }
        if (!blocks.length) return `no installable registry entries matched "${args.query}" (unsupported transports and package types are filtered out)`;
        const tail = r.nextCursor ? `\ncursor: ${r.nextCursor}` : '';
        return blocks.join('\n\n') + tail;
      },
    ),
    def(
      'mcp_manager_probe',
      'Run a real MCP handshake (initialize + tools/list) against one or all registered servers and report tool counts or failure reasons. Read-only.',
      {
        id: { type: 'string', description: 'Optional entry id; omit to probe all' },
        file: { type: 'string', description: 'Optional patch file path' },
        timeout_s: { type: 'number', description: 'Probe timeout in seconds (default 60)' },
      },
      async (args) => {
        const file = args.file ?? patchPath;
        const entries = await readEntries(file);
        if (!entries) return `patch unreadable via loader: ${file}`;
        const targets = args.id ? entries.filter(e => e.id === args.id) : entries.filter(isMcpClientRow);
        if (args.id && targets.length === 0) return `entry not found: ${args.id}`;
        const lines = [];
        for (const e of targets) {
          const r = await probeConfig(e.config, { timeoutMs: (args.timeout_s ?? 60) * 1000 });
          lines.push(r.ok
            ? `OK ${e.id}: ${r.toolCount} tools${r.tools.length ? ' — ' + r.tools.join(', ') : ''}`
            : `FAIL ${e.id}: ${r.error}`);
        }
        return lines.join('\n');
      },
    ),
    def(
      'mcp_manager_add',
      'Resolve a pasted project reference (npm package, GitHub repo URL, MCP HTTP URL, or JSON config fragment) into an official mcp-client patch entry. Dry-run by default; pass confirm:true to write it (runs official validation first).',
      {
        input: { type: 'string', description: 'npm package name, GitHub repo URL, MCP endpoint URL, or JSON config' },
        source: {
          type: 'string',
          enum: ['auto', 'registry'],
          description: 'How to read `input`. "auto" (default) resolves an npm package, GitHub repo, MCP URL or JSON fragment. "registry" treats input as an official MCP Registry name such as ai.ankimcp/anki-mcp-server.',
        },
        confirm: { type: 'boolean', description: 'Write the entry when true; default dry-run' },
        file: { type: 'string', description: 'Optional patch file path' },
      },
      async (args) => {
        if (!args.input) throw new Error('input is required');
        const file = args.file ?? patchPath;
        const { entry, warnings, notes, needsInput } = args.source === 'registry'
          ? await resolveFromRegistry(args.input, file)
          : await resolveInput(args.input);
        const row = renderEntryRow(entry);
        const preview = renderInsertBlock(row).join('\n');
        if (needsInput?.length) return `NEEDS INPUT: ${needsInput.join('; ')}\nnotes: ${notes.join('; ')}`;
        const head = [...notes.map(n => `note: ${n}`), ...warnings.map(w => `warn: ${w}`)];
        if (!args.confirm) return [...head, '--- DRY RUN, nothing written ---', preview, 'confirm:true writes this entry.'].join('\n');
        const r = await applySurgeryAsync({
          file,
          operation: { type: 'appendEntry', row },
          preCommit: appendEntryGate({ id: row.id, serverName: entry.config.serverName }),
        });
        const written = [...head, `written (backup: ${r.backupPath})`];
        // Verify what landed, never the object we just built: probing the
        // in-memory entry reported `probe OK` for rows the loader skips.
        const back = await readBackEntry(file, row.id);
        if (!back.ok) return [...written, `verify FAIL: ${back.error}`].join('\n');
        const pr = await probe(back.config, { timeoutMs: 60000 });
        return [...written, pr.ok ? `probe OK: ${pr.toolCount} tools` : `probe FAIL: ${pr.error}`].join('\n');
      },
    ),
    def(
      'mcp_manager_update',
      "Replace one entry's config subtree with YAML text. Dry-run by default (returns the normalized text plus the official-rule, secret and uniqueness checks); confirm:true writes it through the guarded pipeline (candidate -> loader -> rules -> atomic write with a .bak) and probes the result. Unlike the browser panel, this tool may write !!js expressions — it is the same trust level as editing the patch file by hand.",
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
        if (prep.introducedJsExpr > 0) head.push(`note: this change adds ${prep.introducedJsExpr} new !!js expression(s) — the harness Loader evaluates them at runtime`);
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
    def(
      'mcp_manager_remove',
      'Remove an MCP server entry from the patch file. Requires confirm:true.',
      { id: { type: 'string' }, confirm: { type: 'boolean' }, file: { type: 'string' } },
      async (args) => {
        if (!args.id) throw new Error('id is required');
        if (args.confirm !== true) return `confirm:true is required to remove ${args.id}. This deletes the entry (a .bak backup is kept).`;
        const r = await applySurgeryAsync({ file: args.file ?? patchPath, operation: { type: 'remove', id: args.id } });
        return `removed ${args.id} (backup: ${r.backupPath})`;
      },
    ),
    def(
      'mcp_manager_toggle',
      'Enable or disable an MCP server entry. Requires confirm:true.',
      { id: { type: 'string' }, disabled: { type: 'boolean' }, confirm: { type: 'boolean' }, file: { type: 'string' } },
      async (args) => {
        if (!args.id) throw new Error('id is required');
        const value = args.disabled ?? true;
        if (args.confirm !== true) return `confirm:true is required to set ${args.id} disabled=${value}.`;
        const r = await applySurgeryAsync({ file: args.file ?? patchPath, operation: { type: 'setDisabled', id: args.id, value } });
        return `${args.id} disabled=${value} (backup: ${r.backupPath})`;
      },
    ),
    def(
      'mcp_manager_credential',
      'Locate and mask-display the credential file referenced by an entry via !!js readFileSync, or rotate it (set writes the new value and touches the patch file for HMR re-evaluation).',
      { id: { type: 'string' }, op: { type: 'string', enum: ['get', 'set'] }, value: { type: 'string' }, file: { type: 'string' } },
      async (args) => {
        if (!args.id || !args.op) throw new Error('id and op (get|set) are required');
        const file = args.file ?? patchPath;
        const text = fs.readFileSync(file, 'utf8');
        const { findRow } = await import('./surgery.js');
        const row = findRow(text, args.id);
        if (!row) throw new Error(`entry not found: ${args.id}`);
        const block = text.split('\n').slice(row.startLine, row.endLine + 1).join('\n');
        const m = /readFileSync\(\s*['"]([^'"]+)['"]/.exec(block);
        if (!m) throw new Error(`entry ${args.id} does not reference a credential file via !!js readFileSync`);
        const credPath = m[1].replace(/^~(?=\/|$)/, os.homedir());
        if (args.op === 'get') {
          const val = fs.readFileSync(credPath, 'utf8').trim();
          return `${credPath}: B***** (length ${val.length})`;
        }
        if (!args.value) throw new Error('value is required for op=set');
        fs.writeFileSync(credPath, args.value);
        const now = new Date();
        fs.utimesSync(file, now, now);
        return `credential written to ${credPath}; patch file touched for reload`;
      },
    ),
    def(
      'mcp_manager_validate',
      'Validate an entry (or a proposed config) against the official dsh-mcp-client rules.',
      { id: { type: 'string' }, file: { type: 'string' } },
      async (args) => {
        if (!args.id) throw new Error('id is required');
        const entries = await readEntries(args.file ?? patchPath);
        if (!entries) return `patch unreadable via loader`;
        const e = entries.find(x => x.id === args.id);
        if (!e) throw new Error(`entry not found: ${args.id}`);
        const r = validateEntry(e.config ?? {});
        return r.ok
          ? `OK: ${args.id} satisfies official mcp-client rules${r.warnings.length ? '\n' + r.warnings.map(w => 'warn: ' + w).join('\n') : ''}`
          : `FAIL:\n${r.errors.map(er => 'error: ' + er).join('\n')}`;
      },
    ),
  ];
}
