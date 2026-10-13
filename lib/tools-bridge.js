// Bridge between the official tool-definition shape and the manager libs.
// Definitions follow the hand-built shape used by @deepseek-ai/dsh-mcp-client
// ({name, description, parameters, output:{schema,render}, execute}) and are
// registered directly via ctx.tools.register — no dsh-tools import needed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPatchStructured } from './dump.js';
import { probeConfig } from './probe.js';
import { resolveInput } from './resolve.js';
import { validateEntry, SECRET_KEY_RE } from './rules.js';
import { defaultPatchPath, renderEntryRow, applySurgeryAsync } from './patchfile.js';

function ok(text) { return { text }; }
function err(e) { return { text: `ERROR: ${String(e?.message || e)}` }; }

async function readEntries(patchPath) {
  if (!fs.existsSync(patchPath)) throw new Error(`patch file not found: ${patchPath}`);
  const { entries } = await loadPatchStructured(patchPath);
  if (!entries || entries.length === 0) throw new Error(`no entries parsed from ${patchPath}`);
  return entries;
}

function maskEntry(e) {
  const clone = JSON.parse(JSON.stringify(e));
  for (const dict of ['env', 'headers']) {
    const d = clone.config?.[dict];
    if (d && typeof d === 'object') {
      for (const [k, v] of Object.entries(d)) {
        if (SECRET_KEY_RE.test(k) || (v && typeof v === 'object' && v.__jsExpr)) d[k] = 'B*****';
      }
    }
  }
  return clone;
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

export function createToolDefs(patchPath = defaultPatchPath()) {
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
        for (const e of entries.map(maskEntry)) {
          const c = e.config ?? {};
          lines.push(`${e.id} | ${c.serverName ?? ''} | ${c.transport ?? ''} | ${c.command ?? c.url ?? ''} | ${e.disabled ? 'disabled' : 'enabled'}`);
        }
        return lines.join('\n');
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
        const targets = args.id ? entries.filter(e => e.id === args.id) : entries.filter(e => e.config?.transport);
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
        confirm: { type: 'boolean', description: 'Write the entry when true; default dry-run' },
        file: { type: 'string', description: 'Optional patch file path' },
      },
      async (args) => {
        if (!args.input) throw new Error('input is required');
        const file = args.file ?? patchPath;
        const { entry, warnings, notes, needsInput } = await resolveInput(args.input);
        const row = renderEntryRow(entry);
        const preview = [`- id: ${row.id}`, `  name: '${row.name}'`, ...row.configLines].join('\n');
        if (needsInput?.length) return `NEEDS INPUT: ${needsInput.join('; ')}\nnotes: ${notes.join('; ')}`;
        const head = [...notes.map(n => `note: ${n}`), ...warnings.map(w => `warn: ${w}`)];
        if (!args.confirm) return [...head, '--- DRY RUN, nothing written ---', preview, 'confirm:true writes this entry.'].join('\n');
        const r = await applySurgeryAsync({ file, operation: { type: 'appendEntry', row } });
        const pr = await probeConfig(entry.config, { timeoutMs: 60000 });
        return [...head, `written (backup: ${r.backupPath})`, pr.ok ? `probe OK: ${pr.toolCount} tools` : `probe FAIL: ${pr.error}`].join('\n');
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
