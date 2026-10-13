// Runtime resolution of `!!js` values.
//
// WHY THIS EXISTS: the Cordis entry-list parser turns `!!js <expr>` into an
// INERT marker object, `{ __jsExpr: '<expr>' }`, and the value only becomes real
// when the Loader interpolates it at runtime (see dsh-app-boot's JsExpr type:
// "Its result is evaluated and validated only at runtime"). Anything that
// consumes a config value WITHOUT going through the Loader therefore sees the
// marker, and `String(marker)` is `"[object Object]"`.
//
// That is not hypothetical: lib/probe.js used to forward `config.headers`
// verbatim, so the GitHub row — whose Authorization header is a `!!js`
// expression reading the token file — was probed as
// `Authorization: [object Object]` and answered
//   HTTP 400 bad request: Authorization header is badly formatted
// while the live server, whose header the Loader had interpolated, was perfectly
// healthy. A valid credential was reported as a malformed one.
//
// Evaluating the expression here grants no new capability: the harness Loader
// evaluates the same expressions in-process whenever the patch loads, and the
// browser panel can already cause that by enabling a row. The evaluated values
// are never returned to a caller for display — only the paths that were
// evaluated.
import { createRequire } from 'node:module';

/** createRequire gives the expressions the same `require` the Loader provides. */
const nodeRequire = createRequire(import.meta.url);

/** True for the Loader's inert `!!js` marker. */
export function isJsExpr(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof value.__jsExpr === 'string';
}

/** Evaluate one `!!js` expression. Throws whatever the expression throws. */
export function evalJsExpr(expr) {
  // `process`, `globalThis` and the rest stay real globals; only `require` has
  // to be handed in, because an ESM module has no module-scoped require.
  const fn = new Function('require', `return (${expr});`);
  return fn(nodeRequire);
}

function resolveValue(value, pathLabel, resolved) {
  if (isJsExpr(value)) {
    let out;
    try {
      out = evalJsExpr(value.__jsExpr);
    } catch (e) {
      return { error: `cannot evaluate !!js at ${pathLabel}: ${e.message || e}` };
    }
    if (out === null || out === undefined || typeof out === 'object') {
      return { error: `cannot evaluate !!js at ${pathLabel}: expression produced ${out === null ? 'null' : typeof out}, expected a string or number` };
    }
    resolved.push(pathLabel);
    return { value: out };
  }
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i++) {
      const r = resolveValue(value[i], `${pathLabel}[${i}]`, resolved);
      if (r.error) return r;
      out.push(r.value);
    }
    return { value: out };
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = resolveValue(v, pathLabel ? `${pathLabel}.${k}` : k, resolved);
      if (r.error) return r;
      out[k] = r.value;
    }
    return { value: out };
  }
  return { value };
}

/**
 * Replace every `!!js` marker in a config with its evaluated value.
 *
 * Returns `{ ok: true, config, resolved }` — a fresh structure (the input is
 * never mutated) plus the dotted paths that were evaluated, or
 * `{ ok: false, error }` naming the path that failed. A failure is reported,
 * never silently forwarded: an unresolved marker must not reach a server as
 * `[object Object]`.
 */
export function resolveJsExprs(config) {
  const resolved = [];
  const r = resolveValue(config, '', resolved);
  if (r.error) return { ok: false, error: r.error, resolved };
  return { ok: true, config: r.value, resolved };
}
