// Minimal streamable-http MCP server for probe tests (node:http only).
//
// `requireAuth` mirrors GitHub's own behaviour: a header that is missing or
// malformed is rejected with 400 "Authorization header is badly formatted",
// which is exactly what a probe that forwards the loader's inert `!!js` marker
// (`[object Object]`) used to trigger.
import http from 'node:http';

export function startMiniHttp(port, { requireAuth } = {}) {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    if (requireAuth && req.headers.authorization !== requireAuth) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request: Authorization header is badly formatted' }));
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
      const reply = (result) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'sess-1',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize')
        reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mini-http', version: '0.0.1' } });
      else if (msg.method === 'tools/list')
        reply({ tools: [
          { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
          { name: 'ping', description: 'ping', inputSchema: { type: 'object' } },
        ] });
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: {} })); }
    });
  });
}
