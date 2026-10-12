// Minimal spawn helper (sync) so lib stays dependency-free and testable.
import { spawn } from 'node:child_process';

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
