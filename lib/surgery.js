// Comment-preserving text surgery for cordis.patch.yml.
// Top-level entry: a line matching /^- (id|insert):/ at column 0; it extends to the
// line before the next such line (or EOF). Insert rows: indented "- " item markers
// inside the insert block; a row extends to the next indented item marker or block end.
const TOP_RE = /^- (id|insert):\s*(.*)$/;
const ITEM_RE = /^(\s+)- /;

export function parseTopBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = TOP_RE.exec(lines[i]);
    if (!m) { i++; continue; }
    const kind = m[1] === 'insert' ? 'insert' : 'bare';
    const start = i;
    let j = i + 1;
    const rows = [];
    while (j < lines.length && !TOP_RE.test(lines[j])) {
      if (kind === 'insert') {
        const rm = /^(\s+)- id:\s*(\S+)\s*$/.exec(lines[j]);
        if (rm) {
          let k = j + 1;
          while (k < lines.length && !TOP_RE.test(lines[k]) && !ITEM_RE.test(lines[k])) k++;
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
  let lines = splitLines(text);
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
  const lines = splitLines(text);
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
  lines.splice(row.startLine, seg.length, ...seg);
  return joinLines(lines);
}

export function appendEntry(text, entry) {
  const seg = [`- id: ${entry.id}`, `  name: '${entry.name}'`];
  for (const l of entry.configLines) seg.push('  ' + l);
  const base = text.replace(/\s*$/, '');
  return base + (base ? '\n\n' : '') + seg.join('\n') + '\n';
}
