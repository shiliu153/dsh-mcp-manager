// Minimal newline-delimited JSON-RPC MCP server for probe tests.
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize')
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mini', version: '0.0.1' } } });
  else if (msg.method === 'tools/list')
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
      { name: 'ping', description: 'ping', inputSchema: { type: 'object' } },
    ] } });
});
