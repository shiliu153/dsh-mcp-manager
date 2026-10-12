// Real MCP handshake probe: initialize + tools/list. Read-only, no side effects.
// stdio: newline-delimited JSON-RPC over the child's stdio.
// streamable-http: POST JSON-RPC; follow Mcp-Session-Id; parse JSON or SSE `data:` lines.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const CLIENT_INFO = { name: 'dsh-mcp-manager', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';

export async function probeConfig(config, { timeoutMs = 60000 } = {}) {
  try {
    if (config.transport === 'stdio') return await probeStdio(config, timeoutMs);
    if (config.transport === 'streamable-http') return await probeHttp(config, timeoutMs);
    return { ok: false, tools: [], error: `unknown transport: ${config.transport}` };
  } catch (e) {
    return { ok: false, tools: [], error: String(e.message || e) };
  }
}

async function probeStdio(config, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(config.env ?? {}) },
      cwd: config.cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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

