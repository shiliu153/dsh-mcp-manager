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
      // npm packfiles ("files" allowlist) must include the patch file itself, or
      // GitHub/tarball installs strip it and loader validation fails (E2E 2026-10-13).
      const files = manifest.files ?? [];
      const patchListed = files.some((f) => f === patchRel || f === patchRel.replace(/^\.\//, ''));
      if (!patchListed) errors.push(`files allowlist must include the patch file (${patchRel}) or installs strip it`);
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
  // Client half: declaring dsh.client promises a browser module the installer
  // must ship. Same class of bug as the patch file once being stripped by the
  // npm files allowlist.
  if (manifest.dsh?.client) {
    const clientRel = manifest.exports?.['./client'];
    if (!clientRel) errors.push('dsh.client is declared but exports["./client"] is missing');
    else {
      const clientAbs = path.join(dir, clientRel);
      if (!fs.existsSync(clientAbs)) errors.push(`missing client file: ${clientRel}`);
      const files = manifest.files ?? [];
      const listed = files.some((f) => f === clientRel || f === clientRel.replace(/^\.\//, ''));
      if (!listed) errors.push(`files allowlist must include the client file (${clientRel}) or installs strip it`);
    }
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
