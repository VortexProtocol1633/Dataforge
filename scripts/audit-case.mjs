/*
 * Case-sensitivity audit.
 *
 *   node scripts/audit-case.mjs
 *
 * GitHub Pages serves from a case-sensitive (Linux) filesystem, so any
 * reference whose capitalisation does not exactly match the file on disk works
 * on Windows/macOS but 404s in production. This walks every local reference in
 * the front-end (module imports, <script>/<link>/<img> srcs, CSS url()s) and
 * verifies the exact-case file exists.
 */
import fs from 'fs';
import path from 'path';

const PUBLIC = path.resolve('public');
const exts = ['.js', '.mjs', '.html', '.css'];
let refs = 0;
const problems = [];

/** List a directory and return the map lowercased-name -> real name. */
function realNames(dir) {
  const map = new Map();
  for (const name of fs.readdirSync(dir)) map.set(name.toLowerCase(), name);
  return map;
}

/** Resolve `target` relative to `fromFile`, checking each segment's case. */
function resolveExact(fromFile, target) {
  const base = path.dirname(fromFile);
  const parts = target.split('/').filter((p) => p && p !== '.');
  let cur = base;
  for (const part of parts) {
    if (part === '..') { cur = path.dirname(cur); continue; }
    if (!fs.existsSync(cur) || !fs.statSync(cur).isDirectory()) return { ok: false, why: `not a directory: ${cur}` };
    const real = realNames(cur).get(part.toLowerCase());
    if (real === undefined) return { ok: false, why: `no such entry "${part}" in ${path.relative(PUBLIC, cur) || '.'}` };
    if (real !== part) return { ok: false, why: `case mismatch: wrote "${part}", on disk it is "${real}"` };
    cur = path.join(cur, real);
  }
  if (!fs.existsSync(cur)) return { ok: false, why: 'missing' };
  if (fs.statSync(cur).isDirectory()) return { ok: false, why: 'is a directory' };
  return { ok: true };
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) { walk(full); continue; }
    if (!exts.includes(path.extname(name))) continue;
    const src = fs.readFileSync(full, 'utf8');
    const targets = new Set();

    // static + dynamic module imports and asset imports
    for (const m of src.matchAll(/(?:import|export)\s[^'"()]*from\s*['"]([^'"]+)['"]/g)) targets.add(m[1]);
    for (const m of src.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) targets.add(m[1]);
    // html attribute references (src/href, skip external/anchor/data)
    for (const m of src.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) targets.add(m[1]);
    // css url()
    for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) targets.add(m[1]);

    for (const t of targets) {
      if (/^(https?:)?\/\//i.test(t) || /^(data:|mailto:|tel:|#|\/)/.test(t)) continue; // external / root-absolute / fragment
      if (t.includes('${')) continue; // runtime-built URL, not a static reference
      const clean = t.split(/[?#]/)[0];
      if (!clean || clean.endsWith('/')) continue;
      refs++;
      const r = resolveExact(full, clean);
      if (!r.ok) problems.push(`${path.relative(PUBLIC, full)} → ${clean}  (${r.why})`);
    }
  }
}
walk(PUBLIC);

console.log(`checked ${refs} local references across public/`);
if (problems.length) {
  console.log(`\n${problems.length} case/path problem(s):`);
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('✓ every reference matches the exact case on disk');
