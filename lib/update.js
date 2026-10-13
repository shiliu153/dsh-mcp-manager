// Edit policy for one existing entry: the !!js placeholder protocol plus the
// semantic gates the write pipeline cannot know about.
//
// The browser panel is NOT a trust boundary. A `!!js` scalar is evaluated by the
// harness Loader at runtime, so accepting a new expression from the browser
// would hand arbitrary code execution in the host process to anything that can
// POST to the route. The panel therefore submits opaque placeholders, and this
// module is what turns them back into the row's OWN expressions — never into a
// new one. The CLI and the agent tool are trusted local surfaces and may write
// raw expressions, exactly like hand-editing the patch file.
import fs from 'node:fs';
import { readConfigBlock, replaceConfigBlock, toLf } from './surgery.js';
import { validateEntry, checkSecrets, SECRET_KEY_RE } from './rules.js';
import { isMcpClientRow } from './rows.js';
import { loadPatchText } from './dump.js';
import { applySurgeryAsync } from './patchfile.js';

/** `!!js «3»` — the placeholder the panel sees and sends back. */
const TOKEN_RE = /^(\s*[A-Za-z0-9_-]+:\s*)!!js\s*«(\d+)»\s*$/;
/** A `!!js` value in value position: `  Key: !!js <expression to end of line>`. */
const VALUE_JS_RE = /^(\s*[A-Za-z0-9_-]+:\s*)(!!js\b.*?)\s*$/;
const CRED_RE = /readFileSync\(\s*['"]([^'"]+)['"]/;

/** Every `!!js` expression of one config subtree, in document order. */
export function readJsExprs(configText) {
  const exprs = [];
  for (const line of toLf(String(configText ?? '')).split('\n')) {
    const m = VALUE_JS_RE.exec(line);
    if (m) {
      // A block scalar (`!!js |` / `!!js >`) or a bare tag spans lines: the
      // placeholder protocol is line-based and cannot carry it, so say so
      // instead of tokenizing half an expression.
      if (/^!!js(\s*[|>][-+\d]*)?\s*$/.test(m[2])) return { ok: false, reason: `unsupported !!js form: ${line.trim()}` };
      exprs.push(m[2]);
      continue;
    }
    if (/!!js/.test(line)) return { ok: false, reason: `unsupported !!js form: ${line.trim()}` };
  }
  return { ok: true, exprs };
}

/** Split a submitted fragment into placeholder indices and raw expressions. */
export function scanJsTokens(fragment) {
  const tokens = [], raw = [];
  for (const line of toLf(String(fragment ?? '')).split('\n')) {
    const t = TOKEN_RE.exec(line);
    if (t) { tokens.push(Number(t[2])); continue; }
    if (/!!js/.test(line)) raw.push(line.trim());
  }
  return { tokens, raw };
}

/** Human-readable description of one expression, for the panel's hint line. */
export function describeJsExpr(expr) {
  const m = CRED_RE.exec(expr);
  if (m) return `credential file: ${m[1]}`;
  const one = String(expr).replace(/\s+/g, ' ').trim();
  return `expression: ${one.length > 60 ? one.slice(0, 60) + '…' : one}`;
}

/** What the panel may see: placeholders instead of expressions, secrets masked. */
export function toPanelView(configText) {
  const js = readJsExprs(configText);
  if (!js.ok) return { configText, jsExprs: [], editable: false, reason: js.reason };
  let text = toLf(String(configText ?? ''));
  let editable = true, reason = '';
  if (!checkSecrets(text).ok) {
    text = text.split('\n').map((l) => {
      if (VALUE_JS_RE.test(l)) return l;               // an expression is not a hardcoded secret
      const key = /^\s*([A-Za-z0-9_-]+):/.exec(l)?.[1];
      return key && SECRET_KEY_RE.test(key) ? `${/^(\s*)/.exec(l)[1]}${key}: B*****` : l;
    }).join('\n');
    editable = false;
    reason = 'entry contains a hardcoded secret; fix it from the CLI or the agent tool';
  }
  let i = 0;
  text = text.split('\n').map((l) => {
    const m = VALUE_JS_RE.exec(l);
    return m ? `${m[1]}!!js «${i++}»` : l;
  }).join('\n');
  return { configText: text, jsExprs: js.exprs.map(describeJsExpr), editable, reason };
}

function failure(code, errors, warnings = [], extra = {}) {
  return { ok: false, code, errors, warnings, normalized: '', jsExprCount: 0, introducedJsExpr: 0, ...extra };
}

/**
 * Dry run: normalize the fragment, refill placeholders from THIS row's own
 * expressions, and run the semantic gates against a candidate built in memory.
 * Never writes.
 */
export async function prepareUpdate({ file, id, fragment, allowJsExpr = false }) {
  const text = fs.readFileSync(file, 'utf8');
  const block = readConfigBlock(text, id);
  if (!block) throw new Error(`entry not found: ${id}`);
  const own = readJsExprs(block.configText);
  if (!own.ok) return failure('unsupported_js_form', [own.reason]);
  const { tokens, raw } = scanJsTokens(fragment);
  if (raw.length && !allowJsExpr) {
    return failure('js_expression_forbidden',
      [`!!js expressions cannot be added or edited here: ${raw[0]} — use the CLI or the agent tool`]);
  }
  for (const k of tokens) {
    if (!Number.isInteger(k) || k < 0 || k >= own.exprs.length) {
      return failure('js_expression_forbidden', [`unknown !!js placeholder «${k}»`]);
    }
  }
  let normalized = String(fragment ?? '');
  for (const k of tokens) {
    // A replacer function, not a replacement string: the expressions contain
    // `${…}` and `$` sequences that String.replace would otherwise interpret.
    normalized = normalized.replace(new RegExp(`!!js\\s*«${k}»`), () => own.exprs[k]);
  }
  const after = readJsExprs(normalized);
  if (!after.ok) return failure('unsupported_js_form', [after.reason]);
  const jsExprCount = after.exprs.length;
  const introducedJsExpr = jsExprCount - own.exprs.length;

  let candidate;
  try {
    candidate = replaceConfigBlock(text, id, normalized);
  } catch (e) {
    const msg = String(e.message || e);
    const code = /single line/.test(msg) ? 'flow_config_single_line' : 'candidate_invalid';
    return failure(code, [msg], [], { normalized, jsExprCount, introducedJsExpr });
  }
  const { errors, warnings } = await semanticCheck(candidate, id, normalized);
  if (errors.length) {
    return failure(errors[0].code, errors.map((e) => e.message), warnings, { normalized, jsExprCount, introducedJsExpr });
  }
  return { ok: true, code: '', errors: [], warnings, normalized, candidate, jsExprCount, introducedJsExpr };
}

/**
 * The gates that need a finished candidate: no hardcoded secret, the official
 * field rules, and a serverName that is still unique in the file (the official
 * loader fails the later row on a duplicate, so the earlier one must not be
 * renamed onto an existing name either).
 */
async function semanticCheck(candidateText, id, fragment) {
  const errors = [], warnings = [];
  for (const e of checkSecrets(fragment).errors) errors.push({ code: 'hardcoded_secret', message: e });
  let entries;
  try {
    ({ entries } = await loadPatchText(candidateText));
  } catch (e) {
    return { errors: [{ code: 'candidate_invalid', message: `candidate does not parse: ${e.message}` }], warnings };
  }
  const row = entries.find((e) => e.id === id);
  if (!row) errors.push({ code: 'candidate_invalid', message: `entry disappeared from the candidate: ${id}` });
  else {
    const v = validateEntry(row.config ?? {});
    for (const e of v.errors) errors.push({ code: 'rules_failed', message: e });
    warnings.push(...v.warnings);
  }
  const seen = new Map();
  for (const e of entries.filter(isMcpClientRow)) {
    const n = e.config?.serverName;
    if (!n) continue;
    if (seen.has(n)) errors.push({ code: 'duplicate_server_name', message: `duplicate serverName: ${n} (${seen.get(n)} and ${e.id})` });
    else seen.set(n, e.id);
  }
  return { errors, warnings };
}

/** Dry run, then write through the guarded pipeline. */
export async function applyUpdate({ file, id, fragment, allowJsExpr = false, expectMtime }) {
  const prep = await prepareUpdate({ file, id, fragment, allowJsExpr });
  if (!prep.ok) {
    const e = new Error(prep.errors.join('; '));
    e.code = prep.code;
    e.errors = prep.errors;
    throw e;
  }
  const r = await applySurgeryAsync({
    file,
    expectMtime,
    operation: { type: 'replaceConfig', id, fragment: prep.normalized },
    preCommit: async (candidateText) => {
      const s = await semanticCheck(candidateText, id, prep.normalized);
      if (s.errors.length) throw new Error(s.errors.map((e) => e.message).join('; '));
    },
  });
  return { applied: true, backupPath: r.backupPath, jsExprCount: prep.jsExprCount, introducedJsExpr: prep.introducedJsExpr };
}
