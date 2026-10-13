// Resolve a pasted project reference into an official mcp-client patch row.
import { validateEntry, SERVER_NAME_RE } from './rules.js';

export function deriveServerName(pkg) {
  let n = String(pkg).split('/').pop() || 'server';
  n = n.replace(/-mcp-server$/i, '').replace(/-server-mcp$/i, '').replace(/-mcp$/i, '').replace(/-server$/i, '');
  if (/^server-/.test(n)) n = n.slice('server-'.length) || n;   // official server-* packages: keep the distinctive part
  n = n.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'server';
  return n.slice(0, 32);
}

function hostToName(url) {
  return url.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'remote';
}

const RAW_ENTRY = '@deepseek-ai/dsh-mcp-client';

export async function resolveInput(input, { fetchFn = globalThis.fetch } = {}) {
  const s = String(input).trim();
  const warnings = [], notes = [];

  if (s.startsWith('{') || s.startsWith('[')) return fromJson(s);

  if (/^https?:\/\//i.test(s)) {
    const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i.exec(s);
    if (gh) return fromGitHub(`https://github.com/${gh[1]}/${gh[2].replace(/\.git$/, '')}`, { fetchFn, warnings, notes });
    const entry = { id: `mcp-${hostToName(s)}`, name: RAW_ENTRY, disabled: false, config: { serverName: hostToName(s), transport: 'streamable-http', url: s } };
    return finish(entry, warnings, notes);
  }
  if (/^[\w@][\w./@-]*$/.test(s)) {
    const entry = { id: `mcp-${deriveServerName(s)}`, name: RAW_ENTRY, disabled: false, config: { serverName: deriveServerName(s), transport: 'stdio', command: 'npx', args: ['-y', s] } };
    return finish(entry, warnings, notes);
  }
  throw new Error(`unrecognized input: ${s}`);
}

function finish(entry, warnings, notes) {
  // Every row this plugin writes carries the flag, so a server that cannot start
  // is loud (activation rejected, error logged) instead of silently tool-less.
  // An explicit value from a pasted JSON config wins.
  if (entry.config.failOnStartupError === undefined) entry.config.failOnStartupError = true;
  const v = validateEntry(entry.config);
  warnings.push(...v.warnings);
  if (!v.ok) throw new Error(`resolved entry fails official rules: ${v.errors.join('; ')}`);
  return { entry, warnings, notes, needsInput: [] };
}

function fromJson(s) {
  const obj = JSON.parse(s);
  const servers = obj.mcpServers ?? ((obj.command || obj.url || obj.config) ? { server: obj } : null);
  if (!servers || Object.keys(servers).length !== 1) throw new Error('JSON must contain exactly one server (mcpServers map or single object)');
  const [serverName, def] = Object.entries(servers)[0];
  const config = { serverName: SERVER_NAME_RE.test(serverName) ? serverName : deriveServerName(serverName) };
  if (def.command) {
    config.transport = 'stdio'; config.command = def.command;
    if (def.args) config.args = def.args.map(String);
    if (def.env) config.env = def.env;
    if (def.cwd) config.cwd = def.cwd;
  } else if (def.url) {
    config.transport = 'streamable-http'; config.url = def.url;
    if (def.headers) config.headers = def.headers;
  } else if (def.config?.transport) {
    Object.assign(config, def.config);
  } else throw new Error('JSON server has neither command nor url');
  const entry = { id: `mcp-${config.serverName}`, name: RAW_ENTRY, disabled: false, config };
  return finish(entry, [], []);
}

async function fromGitHub(repoUrl, { fetchFn, warnings, notes }) {
  const m = /github\.com\/([^/]+)\/([^/]+)/.exec(repoUrl);
  const head = `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/`;
  try {
    const res = await fetchFn(head + 'package.json');
    if (res.ok) {
      const pkg = await res.json();
      const npmName = pkg.name;
      notes.push(`package.json found; npm name: ${npmName}`);
      const entry = { id: `mcp-${deriveServerName(npmName)}`, name: RAW_ENTRY, disabled: false, config: { serverName: deriveServerName(npmName), transport: 'stdio', command: 'npx', args: ['-y', npmName] } };
      return finish(entry, warnings, notes);
    }
  } catch (e) { notes.push(`package.json fetch failed: ${e.message}`); }
  try {
    const res = await fetchFn(head + 'README.md');
    if (res.ok) {
      const md = await res.text();
      const endpoint = /https?:\/\/[^\s"'`)]+\/mcp\b[^\s"'`)]*/i.exec(md);
      if (endpoint) {
        notes.push(`README suggests remote endpoint: ${endpoint[0]}`);
        const entry = { id: `mcp-${hostToName(endpoint[0])}`, name: RAW_ENTRY, disabled: false, config: { serverName: hostToName(endpoint[0]), transport: 'streamable-http', url: endpoint[0] } };
        return finish(entry, warnings, notes);
      }
    }
  } catch (e) { notes.push(`README fetch failed: ${e.message}`); }
  return { entry: null, warnings, notes, needsInput: [`无法从 ${repoUrl} 自动推断启动方式:请补充 transport/command/url(可贴 README 片段或 JSON 配置)`] };
}
