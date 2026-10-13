// Minimal stand-in for registry.modelcontextprotocol.io (node:http only), so
// the CLI's network paths are exercised without touching the real registry.
import http from 'node:http';

export const SERVERS = [
  {
    server: {
      name: 'ai.ankimcp/anki-mcp-server',
      title: 'Anki MCP Server',
      description: 'MCP server for Anki flashcards.',
      version: '0.27.0',
      repository: { url: 'https://github.com/ankimcp/anki-mcp-server', source: 'github' },
      packages: [{ registryType: 'npm', identifier: '@ankimcp/anki-mcp-server', version: '0.27.0', transport: { type: 'stdio' } }],
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: 'P', updatedAt: 'U', isLatest: true } },
  },
  {
    server: {
      name: 'ai.x/needs-key',
      title: 'Needs a key',
      description: 'remote server behind a bearer token',
      version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: 'https://api.x/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true, description: 'your token' }] }],
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: 'P', updatedAt: 'U', isLatest: true } },
  },
  {
    server: { name: 'ai.x/sse-only', title: 'SSE only', description: 'not installable', version: '1.0.0', remotes: [{ type: 'sse', url: 'https://x/sse' }] },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', publishedAt: 'P', updatedAt: 'U', isLatest: true } },
  },
];

export function startMiniRegistry(port, { servers = SERVERS } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const single = /^\/v0\/servers\/([^/]+)\/versions\/([^/]+)$/.exec(url.pathname);
    if (single) {
      const name = decodeURIComponent(single[1]);
      const hit = servers.find((s) => s.server.name === name);
      return hit ? send(hit) : send({ title: 'Not Found', status: 404 }, 404);
    }
    if (url.pathname === '/v0/servers') {
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const matched = q ? servers.filter((s) => s.server.name.toLowerCase().includes(q)) : servers;
      return send({ servers: matched, metadata: { count: matched.length } });
    }
    send({ title: 'Not Found', status: 404 }, 404);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
