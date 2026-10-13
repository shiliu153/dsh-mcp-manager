// Guarded write pipeline for cordis.patch.yml:
// read original -> surgery on candidate -> loadOptionalPatches validation ->
// mtime re-check -> .bak -> atomic tmp+rename.
//
// applySurgeryAsync is the canonical entry; it runs the full validation gate
// through DSH's own loader (which may shell out to the harness runtime).
// applySurgery (sync) exists for validate:false call sites only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { removeEntry, setDisabled, appendEntry, replaceConfigBlock, findRow } from './surgery.js';
import { loadPatchStructured } from './dump.js';
import { isMcpClientRow } from './rows.js';

export function defaultPatchPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'cordis.patch.yml');
}

export function renderEntryRow(entry) {
  // configLines are the row's own lines, relative to the row body (no leading
  // indent): appendEntry shifts them under the row it writes. The `config:`
  // header belongs to the row, not to the config object — renderConfig emits
  // only the subtree, so it has to be prepended here.
  const configLines = ['config:', ...renderConfig(entry.config, 0)];
  return { id: entry.id, name: entry.name, disabled: entry.disabled, configLines };
}

/**
 * Why `id` is not a usable, mountable row in this patch text; undefined when it is.
 *
 * Two independent checks, because they fail differently: findRow proves the row
 * sits inside an insert list (the loader warns and skips a bare entry that
 * matches no existing row), and the loader read-back proves the config actually
 * parses back into the fields the server needs.
 *
 * Shared by the pre-write gate and the post-write verification, so a candidate
 * is judged by the same rule before and after it lands.
 */
export function appendedRowProblem(text, entries, id) {
  const row = findRow(text, id);
  if (!row) return `no row named ${id}`;
  if (row.kind !== 'insert-row') {
    return `${id} is not inside an insert list; the loader skips an entry that matches no existing row`;
  }
  const entry = entries.find((e) => e.id === id);
  if (!entry) return `${id} is not readable back through the loader`;
  if (!entry.config?.serverName) return `${id} would persist without a usable config (serverName missing)`;
  return undefined;
}

/**
 * Why `serverName` may not be added alongside these entries; undefined when it may.
 *
 * Counted rather than looked up by id: this plugin derives the id from the
 * serverName (`mcp-<serverName>`), so a duplicate serverName always arrives as a
 * second row carrying the *same* id — an "is it already there" lookup that skips
 * its own id would miss exactly the case it exists to catch. update.js counts
 * the same way.
 */
export function duplicateServerNameProblem(entries, serverName) {
  const holders = entries.filter((e) => isMcpClientRow(e) && e.config?.serverName === serverName);
  if (holders.length > 1) return `duplicate serverName: ${serverName} — ${holders[0].id} is already registered`;
  return undefined;
}

/**
 * The gate the add path hands to applySurgeryAsync: a candidate that would not
 * mount, or that would register a duplicate serverName, never reaches the file.
 */
export function appendEntryGate({ id, serverName }) {
  return async (candidateText, parsed) => {
    const entries = parsed?.entries ?? [];
    const problem = appendedRowProblem(candidateText, entries, id)
      ?? duplicateServerNameProblem(entries, serverName);
    if (problem) throw new Error(problem);
  };
}

/**
 * Read back the row a write just produced, straight from the file.
 *
 * The write paths used to hand the in-memory entry to the probe, so a row that
 * landed flat, or as a bare entry the loader skips, still reported `probe OK`.
 * Verify the persisted row instead and report exactly why it is unusable.
 */
export async function readBackEntry(file, id) {
  const text = fs.readFileSync(file, 'utf8');
  const { entries } = await loadPatchStructured(file);
  const problem = appendedRowProblem(text, entries, id);
  if (problem) return { ok: false, error: problem };
  const entry = entries.find((e) => e.id === id);
  return { ok: true, entry, config: entry.config };
}

// Render a config object as YAML lines at the given depth (2 spaces per level).
// Values starting with !!js are written verbatim (they are expressions, not strings).
function renderConfig(obj, depth) {
  const pad = '  '.repeat(depth + 1);
  const lines = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    if (v === null) { lines.push(`${pad}${key}: null`); continue; }
    if (typeof v === 'boolean' || typeof v === 'number') { lines.push(`${pad}${key}: ${v}`); continue; }
    if (typeof v === 'string') { lines.push(`${pad}${key}: ${yamlScalar(v)}`); continue; }
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${pad}${key}: []`); continue; }
      lines.push(`${pad}${key}:`);
      for (const item of v) lines.push(`${pad}  - ${yamlScalar(item)}`);
      continue;
    }
    lines.push(`${pad}${key}:`);
    lines.push(...renderConfig(v, depth + 1));
  }
  return lines;
}

// A plain scalar may not OPEN with a reserved indicator (`@`, backtick, `#`,
// `&`, `*`, `!`, `|`, `>`, `%`, `{`, `[`, `,`, quotes …). `-`, `?` and `:` are
// legal openers only when followed by a non-space character, which is what
// keeps `-y` (the universal npx flag) plain.
const PLAIN_SAFE_RE = /^(?:[A-Za-z0-9_]|[-?:]\S)[A-Za-z0-9_.\-/:@]*$/;
// Values a YAML reader would coerce to another type, so a string must be quoted.
const YAML_RESERVED_RE = /^(?:true|false|yes|no|on|off|null|~)$/i;
const YAML_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function yamlScalar(v) {
  if (typeof v !== 'string') return JSON.stringify(v);
  if (v.startsWith('!!js')) return v; // verbatim expression
  if (!PLAIN_SAFE_RE.test(v)) return JSON.stringify(v);
  if (YAML_RESERVED_RE.test(v) || YAML_NUMBER_RE.test(v)) return JSON.stringify(v);
  return v;
}

function doSurgery(text, operation) {
  switch (operation.type) {
    case 'appendEntry': return appendEntry(text, operation.row);
    case 'remove': return removeEntry(text, operation.id);
    case 'setDisabled': return setDisabled(text, operation.id, operation.value);
    case 'replaceConfig': return replaceConfigBlock(text, operation.id, operation.fragment);
    default: throw new Error(`unknown surgery operation: ${operation.type}`);
  }
}

// Sync variant: no validation gate (caller must pass validate:false explicitly).
export function applySurgery({ file, operation, validate = false, expectMtime, _forceCandidateText } = {}) {
  if (validate) throw new Error('applySurgery(sync) does not support the validation gate; use applySurgeryAsync');
  const original = fs.readFileSync(file, 'utf8');
  const mtimeMs = fs.statSync(file).mtimeMs;
  if (expectMtime !== undefined && Math.abs(expectMtime - mtimeMs) > 1) {
    throw new Error(`FileChangedExternally: ${file} changed on disk since it was read (expected mtime ${expectMtime}, got ${mtimeMs})`);
  }
  const candidate = _forceCandidateText ?? doSurgery(original, operation);
  return commit(file, candidate, mtimeMs);
}

// Async canonical pipeline — the one callers should use.
//
// `preCommit(candidateText, parsed)` is the semantic gate: the official loader
// proves the candidate is parseable YAML, and preCommit proves it is a *valid
// entry* (official field rules, no hardcoded secret, unique serverName, a shape
// the loader will actually mount). It runs after the loader and before the
// write, so a rejection leaves the live file alone.
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
      const parsed = await loadPatchStructured(candidateFile);
      // preCommit gets the parsed candidate too: the add gate has to inspect the
      // entry's config, not only the text it was rendered from.
      if (preCommit) await preCommit(candidate, parsed);
    } catch (e) {
      throw new Error(`candidate failed validation (kept at ${candidateFile}): ${e.message}`);
    }
    return commit(file, candidate, mtimeMs, candidateFile);
  }
  return commit(file, candidate, mtimeMs);
}

function commit(file, candidate, mtimeMs, candidateFile) {
  // Re-check mtime right before writing: file must not have changed since read.
  const now = fs.statSync(file).mtimeMs;
  if (Math.abs(now - mtimeMs) > 1) {
    throw new Error(`FileChangedExternally: ${file} changed while operating (mtime ${mtimeMs} -> ${now})`);
  }
  const bak = file + '.bak';
  fs.copyFileSync(file, bak);
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, candidate);
  fs.renameSync(tmp, file);
  if (candidateFile) fs.rmSync(candidateFile, { force: true });
  return { applied: true, backupPath: bak };
}
