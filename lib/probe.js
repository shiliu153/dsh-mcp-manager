// Real MCP handshake probe: initialize + tools/list. Read-only, no side effects.
// stdio: newline-delimited JSON-RPC over the child's stdio.
// streamable-http: POST JSON-RPC; follow Mcp-Session-Id; parse JSON or SSE `data:` lines.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { resolveJsExprs } from './jsexpr.js';

const CLIENT_INFO = { name: 'dsh-mcp-manager', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';

// Resolve bare commands through PATHEXT on Windows (cross-spawn semantics the
// official mcp-client inherits from the MCP SDK), so `npx` finds npx.cmd.
function resolveCommand(command) {
  if (process.platform !== 'win32' || path.isAbsolute(command) || /[\\/]/.test(command)) return { command };
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = [...(process.env.PATH ?? '').split(';').filter(Boolean)];
  for (const dir of dirs) {
    for (const ext of exts) {
      const cand = path.join(dir, command + ext);
      try { if (fs.statSync(cand).isFile()) return { command: cand }; } catch { /* keep looking */ }
    }
  }
  // Bare name last: on Windows it is usually a sh script (e.g. nodejs/npx), not spawnable.
  for (const dir of dirs) {
    const plain = path.join(dir, command);
    try { if (fs.statSync(plain).isFile()) return { command: plain }; } catch { /* keep looking */ }
  }
  return { command }; // let spawn report ENOENT with the original name
}

// Node 22 refuses to spawn .cmd/.bat without a shell (CVE-2024-27980 fix, EINVAL).
// The official mcp-client goes through the MCP SDK's cross-spawn which handles this;
// we wrap .cmd/.bat in `cmd.exe /c "<path>"` with verbatim arguments instead.
function spawnShape(resolved) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved.command)) {
    return { command: 'cmd.exe', args: ['/c', `"${resolved.command}"`], windowsVerbatimArguments: true };
  }
  return { command: resolved.command, args: [], windowsVerbatimArguments: false };
}


export async function probeConfig(config, { timeoutMs = 60000 } = {}) {
  // The config came out of the loader, where `!!js` values are still inert
  // markers. The harness interpolates them at runtime; a probe that skips that
  // step sends `[object Object]` as the credential and is told the header is
  // malformed. Resolve first, then hand the server exactly what it would see.
  const resolved = resolveJsExprs(config);
  if (!resolved.ok) return { ok: false, tools: [], error: resolved.error };
  const cfg = resolved.config;
  try {
    if (cfg.transport === 'stdio') return await probeStdio(cfg, timeoutMs);
    if (cfg.transport === 'streamable-http') return await probeHttp(cfg, timeoutMs);
    return { ok: false, tools: [], error: `unknown transport: ${cfg.transport}` };
  } catch (e) {
    return { ok: false, tools: [], error: String(e.message || e) };
  }
}

async function probeStdio(config, timeoutMs) {
  return new Promise((resolve) => {
    const resolved = resolveCommand(config.command);
    const shape = spawnShape(resolved);
    const child = spawn(shape.command, [...shape.args, ...(config.args ?? [])], {
      env: { ...process.env, ...(config.env ?? {}) },
      cwd: config.cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: shape.windowsVerbatimArguments,
    });
    let stderrTail = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, tools: [], error: `stdio probe timed out after ${timeoutMs}ms`, detail: stderrTail.slice(-400) });
    }, timeoutMs);
    child.stderr.on('data', (d) => { stderrTail += d; if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000); });
    const rl = readline.createInterface({ input: child.stdout });

    const pending = new Map();
    rl.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, tools: [], error: `spawn failed: ${e.message}` }); });
    child.on('exit', (code) => {
      if (timer.ref) { /* timer still active: exited before we finished */ }
      clearTimeout(timer);
      resolve({ ok: false, tools: [], error: `server exited early (code ${code})`, detail: stderrTail.slice(-400) });
    });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    const request = (id, method, params) => new Promise((res) => { pending.set(id, res); send({ jsonrpc: '2.0', id, method, params }); });

    (async () => {
      const init = await request(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
      if (init.error) throw new Error(`initialize failed: ${init.error.message ?? JSON.stringify(init.error)}`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const list = await request(2, 'tools/list', {});
      if (list.error) throw new Error(`tools/list failed: ${list.error.message ?? JSON.stringify(list.error)}`);
      const tools = (list.result?.tools ?? []).map((t) => t.name).filter(Boolean);
      clearTimeout(timer);
      child.kill();
      resolve({ ok: true, toolCount: tools.length, tools });
    })().catch((e) => {
      clearTimeout(timer);
      child.kill();
      resolve({ ok: false, tools: [], error: String(e.message || e), detail: stderrTail.slice(-400) });
    });
  });
}

async function probeHttp(config, timeoutMs) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(config.headers ?? {}),
  };
  const url = config.url;
  const post = async (body, sessionId) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      const hint = res.status === 401 || res.status === 403 ? ' (credential expired or unauthorized)' : '';
      throw new Error(`HTTP ${res.status}${hint} ${text}`);
    }
    return parseRpcResponse(res);
  };

  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
  if (init.error) throw new Error(`initialize failed: ${init.error.message ?? JSON.stringify(init.error)}`);
  const sessionId = init.sessionId;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).catch(() => {}); // notification: body may be empty
  const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, sessionId);
  if (list.error) throw new Error(`tools/list failed: ${list.error.message ?? JSON.stringify(list.error)}`);
  const tools = (list.result?.tools ?? []).map((t) => t.name).filter(Boolean);
  return { ok: true, toolCount: tools.length, tools };
}

async function parseRpcResponse(res) {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const sessionId = res.headers.get('mcp-session-id') ?? undefined;
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    for (const line of text.split('\n')) {
      const m = /^data:\s*(.+)$/.exec(line.trim());
      if (!m) continue;
      try {
        const msg = JSON.parse(m[1]);
        if (msg.id !== undefined || msg.result || msg.error) return { ...msg, sessionId };
      } catch { /* keep scanning */ }
    }
    throw new Error('SSE stream contained no JSON-RPC response');
  }
  const text = (await res.text()).trim();
  if (!text) return { result: {}, sessionId };
  const msg = JSON.parse(text);
  return { ...msg, sessionId };
}

