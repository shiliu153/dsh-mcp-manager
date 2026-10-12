// Official dsh-mcp-client entry rules (docs/official/*dsh-mcp-client*README*).
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const SECRET_KEY_RE = /KEY|PASSWORD|SECRET|TOKEN|AUTH/i;

export function validateEntry(config) {
  const errors = [], warnings = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['config must be an object'], warnings };
  if (typeof config.serverName !== 'string' || !SERVER_NAME_RE.test(config.serverName))
    errors.push('serverName must match [A-Za-z0-9_-]{1,32}');
  if (config.transport === 'stdio') {
    if (typeof config.command !== 'string' || !config.command) errors.push('stdio transport requires command');
    if (config.url) warnings.push('stdio entry has url — ignored');
  } else if (config.transport === 'streamable-http') {
    if (typeof config.url !== 'string' || !/^https?:\/\//.test(config.url)) errors.push('streamable-http requires http(s) url');
    if (config.command) warnings.push('streamable-http entry has command — ignored');
  } else errors.push('transport must be "stdio" or "streamable-http"');
  const t = config.toolCallTimeoutMs;
  if (t !== undefined && !(typeof t === 'number' && Number.isFinite(t) && t > 0))
    errors.push('toolCallTimeoutMs must be a positive number');
  const rc = config.reconnect;
  if (rc !== undefined) {
    if (typeof rc !== 'object') errors.push('reconnect must be an object');
    else {
      if (rc.initialDelayMs !== undefined && !(typeof rc.initialDelayMs === 'number' && rc.initialDelayMs >= 1))
        errors.push('reconnect.initialDelayMs must be a number >= 1');
      if (rc.maxDelayMs !== undefined && !(typeof rc.maxDelayMs === 'number' && rc.maxDelayMs >= 1))
        errors.push('reconnect.maxDelayMs must be a number >= 1');
      if (rc.maxDelayMs !== undefined && rc.initialDelayMs !== undefined && rc.maxDelayMs < rc.initialDelayMs)
        errors.push('reconnect.maxDelayMs must be >= initialDelayMs');
      if (rc.maxAttempts !== undefined && !(typeof rc.maxAttempts === 'number' && Number.isInteger(rc.maxAttempts) && rc.maxAttempts >= 1))
        errors.push('reconnect.maxAttempts must be an integer >= 1');
    }
  }
  for (const [dict, label] of [[config.env, 'env'], [config.headers, 'headers']]) {
    if (dict === undefined || dict === null) continue;
    for (const [k, v] of Object.entries(dict)) {
      if (SECRET_KEY_RE.test(k) && typeof v === 'string' && v.trim() && !v.startsWith('!!js'))
        errors.push(`${label}.${k}: secret must live in a credential file referenced via !!js, never hardcoded`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Scan raw patch text for hardcoded secrets on secret-named keys (non-!!js values).
export function checkSecrets(rawBlockText) {
  const errors = [];
  const re = /^\s*([A-Za-z0-9_]+):\s*(?!!js)(['"]?)(\S+)\2\s*$/gm;
  for (const m of rawBlockText.matchAll(re)) {
    if (SECRET_KEY_RE.test(m[1])) errors.push(`${m[1]}: hardcoded secret detected in patch text`);
  }
  return { ok: errors.length === 0, errors };
}
