// Minimal spawn helper (sync) so lib stays dependency-free and testable.
import { spawn, spawnSync } from 'node:child_process';
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

// ---- process-tree termination -------------------------------------------------

/**
 * Kill a spawned process AND everything it spawned.
 *
 * `child.kill()` signals only the direct child. That is not enough here: the
 * probe wraps `.cmd`/`.bat` in `cmd.exe /c` (see lib/probe.js spawnShape), and
 * `npx` resolves to `npx.cmd` on Windows — so the direct child is the wrapper
 * and the real server is a GRANDCHILD. Measured: a grandchild outlived
 * `child.kill()` in isolation, and the orphaned server kept holding its port, so
 * the next probe died with EADDRINUSE and reported a misleading startup error
 * instead of the real reason.
 *
 * SYNCHRONOUS on purpose. The first attempt used an async `spawn('taskkill')`,
 * and the tree still leaked: callers report the probe result and exit in the
 * same tick (`cli/mcp.js` ends with `process.exit`), so the kill had not landed
 * yet. Blocking for the ~50ms `taskkill` takes is the price of actually killing
 * it; a probe already took seconds to get here.
 */
export function killTree(child) {
  const pid = child?.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    } catch { /* fall through to the plain signal */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
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
