// Minimal spawn helper (sync) so lib stays dependency-free and testable.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function spawnFileSync(cmd, args, { env = process.env, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { child.kill('kill'); finish(1, '', stderr + '\n[timeout]'); }
    }, timeoutMs);
    function finish(status, so, se) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status, stdout: so, stderr: se });
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish(1, stdout, stderr + '\n' + e.message));
    child.on('close', (code) => finish(code ?? 1, stdout, stderr));
  });
}

// ---- runtime detection -------------------------------------------------------
// Which MCP runtimes exist on this machine. Detected, never assumed: this bundle
// is published for other people's boxes, and a developer machine with `uvx`
// says nothing about the user's.

const RUNTIME_NAMES = ['npx', 'uvx', 'docker'];

// Windows resolves `npx` to `npx.cmd`; POSIX binaries carry no extension.
const SUFFIXES = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];

/** Absolute path of `name` on PATH, or null. */
export function findOnPath(name) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const suffix of SUFFIXES) {
      const candidate = path.join(dir, name + suffix);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not here; keep looking */ }
    }
  }
  return null;
}

let runtimeCache = null;

/**
 * `{ npx, uvx, docker }` -> boolean, cached for the process lifetime.
 * `refresh: true` re-scans (tests, and a user who just installed uv).
 */
export function detectRuntimes({ refresh = false } = {}) {
  if (runtimeCache && !refresh) return runtimeCache;
  const found = {};
  for (const name of RUNTIME_NAMES) found[name] = Boolean(findOnPath(name));
  runtimeCache = found;
  return found;
}
