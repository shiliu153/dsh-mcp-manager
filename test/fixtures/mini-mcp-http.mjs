// Minimal streamable-http MCP server for probe tests (node:http only).
import http from 'node:http';

export function startMiniHttp(port) {
  return http.createServer((req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
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
