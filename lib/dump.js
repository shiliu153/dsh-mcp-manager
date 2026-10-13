// Structured read of a patch file through DSH's own loader (js-yaml + !!js semantics).
//
// app.asar is only readable by the Electron runtime (its fs hooks understand asar),
// so plain `node` cannot import dsh-app-boot directly. Two paths:
//   1. in-process: when running under the harness itself (process.execPath is the
//      Electron binary), dynamic import works — fast path.
//   2. subprocess bridge: spawn the harness exe with ELECTRON_RUN_AS_NODE=1 and an
//      inline script; JSON over stdout (validate_patch.js precedent).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnFileSync } from './subprocess.js';

const HARNESS_EXE = process.execPath; // ...\DeepSeek Harness.exe inside host; plain node.exe otherwise
const IS_ELECTRON = /deepseek harness/i.test(HARNESS_EXE);

function asarLoaderUrl() {
  // file:// URL with percent-encoded spaces; per validate_patch.js line 13.
  const res = IS_ELECTRON
    ? path.join(path.dirname(HARNESS_EXE), 'resources', 'app.asar')
    : 'C:/Users/20157/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
  return 'file:///' + encodeURI(res.replace(/\\/g, '/')) + '/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
}

let mod;
async function loaderModule() {
  if (mod) return mod;
  if (!IS_ELECTRON) return null; // plain node: skip in-process, go straight to bridge
  mod = await import(asarLoaderUrl());
  return mod;
}

const BRIDGE_SCRIPT = `
const file = process.argv[1];
const { loadOptionalPatches } = await import(process.argv[2]);
try {
  const patches = loadOptionalPatches('dsh', file);
  process.stdout.write(JSON.stringify({ ok: true, patches }));
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e) }));
}
`;

async function viaBridge(file) {
  const exe = IS_ELECTRON
    ? HARNESS_EXE
    : 'C:/Users/20157/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe';
  // argv layout under `-e script arg1 arg2`: argv[1]=arg1, argv[2]=arg2 (exe itself is argv[0]; -e and -- are consumed).
  const out = await spawnFileSync(exe, ['-e', BRIDGE_SCRIPT, '--', file, asarLoaderUrl()], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: 30000,
  });
  if (out.status !== 0 && !(out.stdout ?? '').trim()) {
    throw new Error(`loader bridge failed (exit ${out.status}): ${(out.stderr ?? '').slice(0, 400)}`);
  }
  const line = (out.stdout ?? '').trim().split('\n').pop() ?? '';
  let parsed;
  try { parsed = JSON.parse(line); }
  catch (e) { throw new Error(`loader bridge produced non-JSON output: ${line.slice(0, 200)} | stderr: ${(out.stderr ?? '').slice(0, 200)}`); }
  if (!parsed.ok) throw new Error(`patch parse failed: ${parsed.error}`);
  return parsed.patches;
}

export async function loadPatchStructured(file) {
  let patches;
  const m = await loaderModule();
  if (m) {
    try {
      patches = m.loadOptionalPatches('dsh', file);
    } catch (e) {
      throw new Error(`patch parse failed: ${e.message}`);
    }
  } else {
    patches = await viaBridge(file);
  }
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

/**
 * Parse patch TEXT through the official loader.
 *
 * loadOptionalPatches() takes a path, so the text goes to a temp file that is
 * removed in a finally block — the update policy layer has to validate a
 * candidate it holds only in memory.
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
