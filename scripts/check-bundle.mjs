// Bundle compliance self-check per docs/official host-plugin.md rules.
import fs from 'node:fs';
import path from 'node:path';

export function checkBundle(dir) {
  const errors = [], warnings = [];
  const manifestPath = path.join(dir, 'package.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return { ok: false, errors: [`package.json unreadable: ${e.message}`], warnings }; }

  if (!manifest.name || typeof manifest.name !== 'string') errors.push('missing name');
  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) errors.push('missing/invalid version');
  if (manifest.type !== 'module') errors.push('"type" must be "module"');
  if (!manifest.exports || !manifest.exports['.']) errors.push('exports must expose "." entry');

  const patchRel = manifest?.dsh?.bundle?.patch;
  if (!patchRel) errors.push('missing dsh.bundle.patch');
  else {
    const patchAbs = path.join(dir, patchRel);
    if (!fs.existsSync(patchAbs)) errors.push(`missing patch file: ${patchRel}`);
    else {
      const text = fs.readFileSync(patchAbs, 'utf8');
      if (!/^- insert:/m.test(text) && !/^- id:/m.test(text)) errors.push('patch has no top-level entries');
      if (!/- id:\s*\S+/.test(text)) errors.push('patch has no row ids');
    }
  }
  for (const loc of ['locale/en.json', 'locale/zh.json']) {
    const p = path.join(dir, loc);
    if (!fs.existsSync(p)) { errors.push(`missing ${loc}`); continue; }
    try {
      const meta = JSON.parse(fs.readFileSync(p, 'utf8')).meta;
      if (!meta?.title) errors.push(`${loc} missing meta.title`);
      if (!meta?.description) errors.push(`${loc} missing meta.description`);
    } catch (e) { errors.push(`${loc} unparsable: ${e.message}`); }
  }
  const icon = manifest.icon;
  if (!icon) warnings.push('no icon declared');
  else {
    const ip = path.join(dir, icon);
    if (!fs.existsSync(ip)) errors.push(`icon file missing: ${icon}`);
    else if (path.relative(dir, path.resolve(ip)).startsWith('..')) errors.push('icon path escapes bundle dir');
    else if (fs.statSync(ip).size > 256 * 1024) errors.push('icon exceeds 256 KiB');
  }
  return { ok: errors.length === 0, errors, warnings };
}

// CLI entry: node scripts/check-bundle.mjs [dir]
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const target = process.argv[2] ?? path.dirname(new URL(import.meta.url).pathname);
  const r = checkBundle(target);
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
