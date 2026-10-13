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
import { removeEntry, setDisabled, appendEntry } from './surgery.js';
import { loadPatchStructured } from './dump.js';

export function defaultPatchPath() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'cordis.patch.yml');
}

export function renderEntryRow(entry) {
  const configLines = renderConfig(entry.config, 0);
  return { id: entry.id, name: entry.name, disabled: entry.disabled, configLines };
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
export async function applySurgeryAsync({ file, operation, validate = true, expectMtime } = {}) {
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
