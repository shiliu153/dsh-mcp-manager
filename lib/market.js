// Pure policy: one official-registry entry -> one candidate mcp-client row.
// No network, no disk, no clock — every branch here is unit-testable.
//
// Registry data is hostile input: anyone may publish. Fields are read
// defensively, strings are clamped, and only https URLs survive.
import { validateEntry, SECRET_KEY_RE } from './rules.js';
import { RAW_ENTRY } from './resolve.js';

/**
 * Registry package types this plugin can actually run.
 * `cargo` / `nuget` / `mcpb` are deliberately absent (spec D6): mcpb would need
 * a download plus sha256 verification, which is a piece of work on its own.
 */
export const SUPPORTED_REGISTRY_TYPES = {
  npm: { command: 'npx', runtime: 'npx', pin: (id, v) => `${id}@${v}` },
  pypi: { command: 'uvx', runtime: 'uvx', pin: (id, v) => `${id}==${v}` },
  oci: { command: 'docker', runtime: 'docker', pin: (id, v) => `${id}:${v}` },
};

/** Flags that belong to the runtime, not to the package. */
const RUNTIME_ARGS = {
  npm: ['-y'],
  pypi: [],
  oci: ['run', '-i', '--rm'],
};

/**
 * MUST stay a superset of rules.js SECRET_KEY_RE.
 *
 * rules.js refuses any non-`!!js` value on a KEY/PASSWORD/SECRET/TOKEN/AUTH-named
 * key. Anything this regex misses but rules.js catches would be written into
 * `entryConfig` and then rejected by the official-rule gate — a candidate we
 * built ourselves and cannot install. Deriving from SECRET_KEY_RE keeps the two
 * in step; `CREDENTIAL` is added on top.
 */
const SECRET_NAME_RE = new RegExp(`${SECRET_KEY_RE.source}|CREDENTIAL`, 'i');

const NAME_CEILING = 32;

function str(v, max = 200) { return typeof v === 'string' ? v.slice(0, max) : ''; }
function isHttpsUrl(v) { return typeof v === 'string' && /^https:\/\//i.test(v); }

/**
 * Three signals, because none of them is reliable alone (spec constraint 4):
 * the explicit flag, a required template placeholder, and the name itself.
 * Verified miss: a Smithery header carrying `value: "Bearer {smithery_api_key}"`
 * with no `isSecret` at all.
 */
export function isSecretInput(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.isSecret === true) return true;
  if (input.isRequired === true && /\{[^}]+\}/.test(str(input.value, 500))) return true;
  return SECRET_NAME_RE.test(str(input.name, 100));
}

function gapOf(input, kind) {
  return {
    kind,
    name: str(input?.name, 100) || str(input?.valueHint, 100) || '(unnamed)',
    description: str(input?.description, 300),
    required: input?.isRequired === true,
    placeholder: str(input?.placeholder, 200),
  };
}

/**
 * DSH serverName from a reverse-DNS registry name, de-duplicated against what
 * is already registered. The suffix is clamped so the result never exceeds the
 * official 32-character ceiling.
 */
export function deriveMarketServerName(registryName, existingNames = []) {
  const tail = String(registryName ?? '').split('/').pop() ?? '';
  const base = tail.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_CEILING) || 'server';
  if (!existingNames.includes(base)) return base;
  for (let i = 2; i < 100; i++) {
    const suffix = `-${i}`;
    const candidate = base.slice(0, NAME_CEILING - suffix.length) + suffix;
    if (!existingNames.includes(candidate)) return candidate;
  }
  return base.slice(0, NAME_CEILING - 2) + '-x';
}

/** The full patch row for a candidate, in the shape renderEntryRow expects. */
export function toEntry(candidate) {
  if (!candidate?.ok) throw new Error(`not installable: ${candidate?.reason ?? 'unknown'}`);
  return {
    id: `mcp-${candidate.entryConfig.serverName}`,
    name: RAW_ENTRY,
    disabled: false,
    config: candidate.entryConfig,
  };
}

function pickTransport(server) {
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const http = remotes.find((r) => r?.type === 'streamable-http' && isHttpsUrl(r.url));
  if (http) return { kind: 'streamable-http', remote: http };
  const packages = Array.isArray(server.packages) ? server.packages : [];
  const pkg = packages.find((p) => SUPPORTED_REGISTRY_TYPES[p?.registryType]);
  if (pkg) return { kind: 'stdio', pkg };
  return { kind: 'none' };
}

function unsupportedReason(server) {
  const remotes = Array.isArray(server.remotes) ? server.remotes : [];
  const packages = Array.isArray(server.packages) ? server.packages : [];
  if (!packages.length && remotes.some((r) => r?.type === 'sse')) {
    return 'sse transport is not supported by dsh-mcp-client';
  }
  const types = [...new Set(packages.map((p) => p?.registryType).filter(Boolean))];
  if (types.length) return `unsupported package type: ${types.join(', ')}`;
  if (remotes.length) return 'no usable transport (needs streamable-http)';
  return 'entry declares neither a package nor a remote';
}

/**
 * `{name}` placeholders in a remote URL; unresolved names become gaps.
 * Returns the unresolved count too: an empty substitution still yields a
 * syntactically valid https URL (`https://api.test//mcp`), and writing that
 * would mean knowingly persisting a URL we know is incomplete.
 */
function substituteVars(template, variables, gaps) {
  const vars = variables && typeof variables === 'object' ? variables : {};
  let unresolved = 0;
  const value = template.replace(/\{([^}]+)\}/g, (_, name) => {
    const input = vars[name];
    if (input && typeof input === 'object' && !isSecretInput(input)) {
      const filled = str(input.value ?? input.default, 500);
      if (filled) return filled;
    }
    unresolved += 1;
    gaps.push({
      kind: 'variable', name,
      description: str(input?.description, 300),
      required: input?.isRequired === true,
      placeholder: str(input?.placeholder, 200),
    });
    return '';
  });
  return { value, unresolved };
}

/** env / headers: secret-looking entries go to gaps, empty ones are dropped. */
function mapKeyValues(list, gaps) {
  const out = {};
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const name = str(item.name, 100);
    if (!name) continue;
    if (isSecretInput(item)) { gaps.push(gapOf(item, 'secret')); continue; }
    const value = str(item.value ?? item.default, 500);
    if (!value) {
      // Writing `KEY: ''` is noise, so a valueless optional var is dropped
      // outright; only a required one is worth telling the user about.
      if (item.isRequired === true) gaps.push(gapOf(item, 'variable'));
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** runtimeArguments / packageArguments -> argv entries. */
function mapArguments(list, gaps, kind) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    if (isSecretInput(a)) { gaps.push(gapOf(a, kind)); continue; }
    const value = str(a.value ?? a.default, 500);
    if (a.type === 'named') {
      const flag = str(a.name, 100);
      if (!flag) continue;
      if (!value && a.isRequired === true) { gaps.push(gapOf(a, kind)); continue; }
      out.push(flag);
      if (value) out.push(value);
      continue;
    }
    if (!value) { if (a.isRequired === true) gaps.push(gapOf(a, kind)); continue; }
    out.push(value);
  }
  return out;
}

export function toCandidate(server, { existingNames = [], runtimeProbe = {} } = {}) {
  const s = server && typeof server === 'object' ? server : {};
  const meta = s._meta?.['io.modelcontextprotocol.registry/official'] ?? {};
  const registryName = str(s.name, 200);
  const provenance = {
    registryName,
    publisher: registryName.split('/')[0] ?? '',
    title: str(s.title, 100),
    description: str(s.description, 100),
    version: str(s.version, 100),
    publishedAt: str(meta.publishedAt, 40),
    updatedAt: str(meta.updatedAt, 40),
    repositoryUrl: isHttpsUrl(s.repository?.url) ? s.repository.url : '',
    websiteUrl: isHttpsUrl(s.websiteUrl) ? s.websiteUrl : '',
    status: str(meta.status, 20) || 'active',
  };
  const serverName = deriveMarketServerName(registryName, existingNames);
  const picked = pickTransport(s);

  if (picked.kind === 'none') {
    return { ok: false, reason: unsupportedReason(s), serverName, provenance, gaps: [] };
  }

  const gaps = [];
  const config = { serverName, failOnStartupError: true };
  let execution;
  let pinned = null;

  if (picked.kind === 'streamable-http') {
    const remote = picked.remote;
    const sub = substituteVars(str(remote.url, 500), remote.variables, gaps);
    if (sub.unresolved > 0) {
      return {
        ok: false,
        reason: `remote url has ${sub.unresolved} unresolved template variable(s): ${sub.value}`,
        serverName, provenance, gaps,
      };
    }
    if (!isHttpsUrl(sub.value)) {
      return {
        ok: false,
        reason: `remote url is not a usable https endpoint: ${sub.value || '(empty)'}`,
        serverName, provenance, gaps,
      };
    }
    config.transport = 'streamable-http';
    config.url = sub.value;
    const headers = mapKeyValues(remote.headers, gaps);
    if (Object.keys(headers).length) config.headers = headers;
    execution = { kind: 'streamable-http', url: sub.value };
  } else {
    const pkg = picked.pkg;
    const spec = SUPPORTED_REGISTRY_TYPES[pkg.registryType];
    const identifier = str(pkg.identifier, 300);
    const version = str(pkg.version, 100);
    if (!identifier) {
      return { ok: false, reason: 'package entry has no identifier', serverName, provenance, gaps };
    }
    pinned = version || null;
    const args = [
      ...RUNTIME_ARGS[pkg.registryType],
      ...mapArguments(pkg.runtimeArguments, gaps, 'argument'),
      version ? spec.pin(identifier, version) : identifier,
      ...mapArguments(pkg.packageArguments, gaps, 'argument'),
    ];
    config.transport = 'stdio';
    config.command = spec.command;
    config.args = args;
    const env = mapKeyValues(pkg.environmentVariables, gaps);
    if (Object.keys(env).length) config.env = env;
    execution = { kind: 'stdio', command: spec.command, args, runtimePresent: runtimeProbe[spec.runtime] !== false };
  }

  // Belt and braces: never hand the write pipeline a candidate the official
  // rules are bound to refuse.
  const v = validateEntry(config);
  if (!v.ok) {
    return { ok: false, reason: `mapped entry fails official rules: ${v.errors.join('; ')}`, serverName, provenance, gaps };
  }
  return { ok: true, serverName, entryConfig: config, pinned, provenance, execution, gaps };
}
