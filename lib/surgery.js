// Comment-preserving text surgery for cordis.patch.yml.
// Top-level entry: a line matching /^- (id|insert):/ at column 0; it extends to the
// line before the next such line (or EOF). Insert rows: item markers at the SAME
// indentation as the block's `- id:` line; a row extends to the next such marker or
// block end. One entry's config subtree can be read and replaced wholesale.
const TOP_RE = /^- (id|insert):\s*(.*)$/;
const ITEM_RE = /^(\s+)- /;

// Row boundary inside an `insert:` block: the marker must sit at the SAME
// indentation as that block's `- id:` line. The old rule (ITEM_RE, any
// indentation) mistook a nested block sequence for a new row:
//
//     - id: mcp-blocky
//       config:
//         args:
//           - -y          <- matched ITEM_RE -> the row ended here
//           - blocky-mcp
//
// findRow then returned a range truncated at `args:`, and every surgery that
// splices that range (setDisabled / remove / replaceConfigBlock) corrupted the
// entry. Flow-style args hid the bug; the editor makes block style reachable.
// `itemIndent === undefined` (no row seen yet) keeps the old behaviour.
function isItemAt(line, itemIndent) {
  if (itemIndent === undefined) return ITEM_RE.test(line);
  return new RegExp(`^ {${itemIndent}}- `).test(line);
}

// Every entry point normalizes line endings before doing anything else.
//
// This is not cosmetic. TOP_RE ends in `(.*)$`, and in JavaScript `.` does not
// match a carriage return while `$` (no `m` flag) only matches at end of input
// or before a final newline. A CRLF line therefore never matches TOP_RE, and
// parseTopBlocks silently swallows every following top-level block into the one
// before it - so findRow reports "entry not found" for rows that are plainly
// there, and toggle/remove break on any patch file a Windows editor has
// touched. Normalizing here also keeps the output consistently LF, which is
// what appendEntry already emits.
export function toLf(text) { return text.replace(/\r\n?/g, '\n'); }

export function parseTopBlocks(text) {
  const lines = toLf(text).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = TOP_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const kind = m[1] === 'insert' ? 'insert' : 'bare';
    const start = i;
    let j = i + 1;
    const rows = [];
    let itemIndent;
    while (j < lines.length && !TOP_RE.test(lines[j])) {
      if (kind === 'insert') {
        const rm = /^(\s+)- id:\s*(\S+)\s*$/.exec(lines[j]);
        if (rm) {
          itemIndent = rm[1].length;
          let k = j + 1;
          while (k < lines.length && !TOP_RE.test(lines[k]) && !isItemAt(lines[k], itemIndent)) k++;
          rows.push({ id: stripQuotes(rm[2]), startLine: j, endLine: k - 1 });
          j = k;
          continue;
        }
      }
      j++;
    }
    const block = { kind, startLine: start, endLine: j - 1 };
    if (kind === 'insert') block.rows = rows;
    else block.id = stripQuotes((m[2] || '').trim());
    blocks.push(block);
    i = j;
  }
  return blocks;
}

function stripQuotes(s) { return s.replace(/^['"]|['"]$/g, ''); }

export function findRow(text, id) {
  for (const b of parseTopBlocks(text)) {
    if (b.kind === 'bare' && b.id === id) return { kind: 'bare', startLine: b.startLine, endLine: b.endLine };
    for (const r of b.rows ?? []) if (r.id === id) return { kind: 'insert-row', startLine: r.startLine, endLine: r.endLine, blockStart: b.startLine, blockEnd: b.endLine };
  }
  return undefined;
}

function splitLines(text) { return text.split('\n'); }
function joinLines(lines) { return lines.join('\n'); }

export function removeEntry(text, id) {
  const row = findRow(text, id);
  if (!row) throw new Error(`entry not found: ${id}`);
  let lines = splitLines(toLf(text));
  if (row.kind === 'bare') {
    lines.splice(row.startLine, row.endLine - row.startLine + 1);
    return joinLines(lines);
  }
  lines.splice(row.startLine, row.endLine - row.startLine + 1);
  let out = joinLines(lines);
  // If the owning insert block now has no rows, drop the whole block.
  const blocks = parseTopBlocks(out);
  const ins = blocks.find(b => b.kind === 'insert');
  if (ins && (ins.endLine - ins.startLine) <= 1) {
    lines = splitLines(out);
    const blankBefore = ins.startLine > 0 && lines[ins.startLine - 1] === '';
    const dropStart = ins.startLine - (blankBefore ? 1 : 0);
    lines.splice(dropStart, ins.endLine - dropStart + 1);
    out = joinLines(lines);
  }
  return out;
}

export function setDisabled(text, id, value) {
  const row = findRow(text, id);
  if (!row) throw new Error(`entry not found: ${id}`);
  const lines = splitLines(toLf(text));
  const seg = lines.slice(row.startLine, row.endLine + 1);
  const disIdx = seg.findIndex(l => /^\s*disabled:\s*/.test(l));
  if (disIdx >= 0) {
    seg[disIdx] = seg[disIdx].replace(/disabled:\s*.*/, `disabled: ${value}`);
  } else {
    // indent = id line's indent + 2 spaces
    const idLine = seg[0];
    const idIndent = /^( *)- id:/.exec(idLine)?.[1]?.length ?? 0;
    const indent = idIndent + 2;
    seg.splice(1, 0, ' '.repeat(indent) + `disabled: ${value}`);
  }
  lines.splice(row.startLine, row.endLine - row.startLine + 1, ...seg);
  return joinLines(lines);
}

/**
 * Render one entry as the insert block appendEntry writes.
 *
 * Single source of truth for the written shape: every preview (agent tool, CLI,
 * panel) renders through here, so a preview can never drift from the file.
 *
 * A bare top-level entry overrides an EXISTING row by id; one that matches no
 * row is warned about and skipped. A freshly added server therefore has to go
 * inside an insert list, as its own block so no existing block is touched.
 */
export function renderInsertBlock(entry) {
  const rowPad = '    ';    // the `- id:` marker inside a top-level insert list
  const bodyPad = '      '; // that row's own keys
  const lines = ['- insert:', `${rowPad}- id: ${entry.id}`, `${bodyPad}name: '${entry.name}'`];
  if (entry.disabled !== undefined) lines.push(`${bodyPad}disabled: ${entry.disabled}`);
  for (const l of entry.configLines) lines.push(l === '' ? '' : bodyPad + l);
  return lines;
}

export function appendEntry(text, entry) {
  const seg = renderInsertBlock(entry);
  const base = toLf(text).replace(/\s*$/, '');
  return base + (base ? '\n\n' : '') + seg.join('\n') + '\n';
}

// ---- one entry's config subtree ----
//
// The panel and the CLI edit raw YAML text rather than parsed fields, because a
// parsed entry cannot round-trip a `!!js` expression: the loader hands back an
// inert {__jsExpr} marker object, and renderConfig only understands a *string*
// that starts with `!!js`. Re-rendering from the parsed object would silently
// destroy the credential header on the GitHub row. Text in, text out.

const CONFIG_RE = /^(\s*)config:\s*(.*)$/;

function indentOf(line) { return /^( *)/.exec(line)[1].length; }

/** Common leading-space count of the non-blank lines. */
function commonIndent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    min = Math.min(min, indentOf(l));
  }
  return min === Infinity ? 0 : min;
}

/** Drop up to `n` leading spaces per line; blank lines become empty. */
function dedent(lines, n) {
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(Math.min(n, indentOf(l)))));
}

/**
 * Locate one entry's `config:` subtree.
 *
 * kind 'block'  — `config:` alone on its line; the subtree follows.
 * kind 'flow'   — `config: {…}` inline; configText is the inline value.
 * kind 'absent' — the entry has no `config:` line; startLine is the insertion
 *                 point (right after `- id:`, or after a leading `name:` /
 *                 `disabled:` pair).
 *
 * `indent` is the indentation to write back with (the file's own `config:`
 * indent + 2, or `- id:` indent + 4 when absent); `baseIndent` is what the
 * subtree actually used. `configText` is dedented by `baseIndent`, so feeding
 * it straight back reproduces the file byte-for-byte.
 */
export function readConfigBlock(text, id) {
  const row = findRow(text, id);
  if (!row) return undefined;
  const lines = splitLines(toLf(text));
  const seg = lines.slice(row.startLine, row.endLine + 1);
  const idIndent = /^( *)- id:/.exec(seg[0])?.[1]?.length ?? 0;
  let cfgIdx = -1;
  for (let i = 1; i < seg.length; i++) if (CONFIG_RE.test(seg[i])) { cfgIdx = i; break; }
  if (cfgIdx < 0) {
    let at = 1;
    while (at < seg.length && /^\s*(name|disabled):/.test(seg[at])) at++;
    return { kind: 'absent', indent: idIndent + 4, baseIndent: idIndent + 4, configText: '',
             startLine: row.startLine + at, endLine: row.startLine + at - 1 };
  }
  const m = CONFIG_RE.exec(seg[cfgIdx]);
  const cfgIndent = m[1].length;
  const inline = m[2].trim();
  if (inline) {
    return { kind: 'flow', indent: cfgIndent + 2, baseIndent: cfgIndent + 2, configText: inline,
             startLine: row.startLine + cfgIdx, endLine: row.startLine + cfgIdx };
  }
  let end = cfgIdx + 1;
  while (end < seg.length && (seg[end].trim() === '' || indentOf(seg[end]) > cfgIndent)) end++;
  while (end > cfgIdx + 1 && seg[end - 1].trim() === '') end--;
  const sub = seg.slice(cfgIdx + 1, end);
  const baseIndent = commonIndent(sub);
  return { kind: 'block', indent: cfgIndent + 2, baseIndent,
           configText: dedent(sub, baseIndent).join('\n'),
           startLine: row.startLine + cfgIdx + 1, endLine: row.startLine + end - 1 };
}

/** Strip a fragment's common indent, drop blank edges, re-indent by `indent`. */
function normalizeFragment(fragment, indent) {
  const raw = toLf(String(fragment ?? '')).split('\n');
  while (raw.length && raw[0].trim() === '') raw.shift();
  while (raw.length && raw[raw.length - 1].trim() === '') raw.pop();
  if (raw.length === 0) return [];
  const base = commonIndent(raw);
  return dedent(raw, base).map((l) => (l === '' ? '' : ' '.repeat(indent) + l));
}

/**
 * Replace one entry's `config:` subtree with `fragment`, touching nothing else:
 * the comment block above the entry, `- id:`, `name:` and `disabled:` all stay
 * byte-identical, as do all other entries.
 *
 * Round-trip invariant: feeding back readConfigBlock().configText reproduces
 * the file byte-for-byte whenever the subtree used the canonical indentation
 * (config indent + 2). A deeper-than-canonical subtree is normalized instead.
 */
export function replaceConfigBlock(text, id, fragment) {
  const block = readConfigBlock(text, id);
  if (!block) throw new Error(`entry not found: ${id}`);
  const lines = splitLines(toLf(text));
  const body = normalizeFragment(fragment, block.indent);
  if (block.kind === 'flow') {
    if (body.length !== 1) throw new Error('flow-style config accepts a single line');
    // Replacer function, not a replacement string: the inline value may contain `$&`.
    lines[block.startLine] = lines[block.startLine].replace(/^(\s*config:\s*).*$/, (_m, head) => head + body[0].trim());
    return joinLines(lines);
  }
  if (block.kind === 'absent') {
    lines.splice(block.startLine, 0, ' '.repeat(block.indent - 2) + 'config:', ...body);
    return joinLines(lines);
  }
  lines.splice(block.startLine, block.endLine - block.startLine + 1, ...body);
  return joinLines(lines);
}
