#!/usr/bin/env node
// tools/admin/verify-dist.mjs — проверка, что в dist нет админки и мусора.
// Использование: node tools/admin/verify-dist.mjs [--dist <dir>] [--manifest <sha256-файл>]
// Коды выхода: 0 — ок; 1 — найдены нарушения.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const distDir = path.resolve(arg('--dist', 'dist'));
const manifest = arg('--manifest', null);
const problems = [];

if (!fs.existsSync(distDir)) {
  console.error(`FAIL: нет каталога ${distDir} — сначала npm run build`);
  process.exit(1);
}

const FORBIDDEN_SEGMENTS = new Set(['admin', 'tools', 'api', '.token']);
const MARKERS = ['/api/save', 'admin-ui', 'ADMIN_TOKEN', 'Bearer '];

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else files.push(path.relative(distDir, p));
  }
})(distDir);

for (const rel of files) {
  const segs = rel.split(path.sep);
  for (const s of segs) {
    if (FORBIDDEN_SEGMENTS.has(s.toLowerCase())) {
      problems.push(`запрещённый сегмент пути: ${rel}`);
    }
  }
  if (/\.(backup|original)(-|$)|\.before-|\.bak$/i.test(path.basename(rel))) {
    problems.push(`резервная копия/мусор в сборке: ${rel}`);
  }
  if (/admin/i.test(path.basename(rel))) problems.push(`имя файла содержит "admin": ${rel}`);
}

const textExt = new Set(['.html', '.js', '.css', '.json', '.txt', '.svg', '.xml', '.map']);
for (const rel of files) {
  if (!textExt.has(path.extname(rel).toLowerCase())) continue;
  const content = fs.readFileSync(path.join(distDir, rel), 'utf8');
  for (const marker of MARKERS) {
    if (content.includes(marker)) problems.push(`маркер «${marker}» найден в ${rel}`);
  }
}

if (manifest) {
  const base = new Map();
  for (const line of fs.readFileSync(manifest, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [hash, rel] = line.split('  ');
    base.set(rel, hash);
  }
  const crypto = await import('node:crypto');
  for (const [rel, hash] of base) {
    const abs = path.resolve(rel);
    if (!fs.existsSync(abs)) { problems.push(`нет файла из манифеста: ${rel}`); continue; }
    const now = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (now !== hash) problems.push(`файл отличается от baseline: ${rel}`);
  }
  for (const rel of files) {
    const key = path.join('dist', rel).split(path.sep).join('/');
    if (!base.has(key)) problems.push(`новый файл вне baseline: ${key}`);
  }
}

if (problems.length) {
  for (const p of problems) console.log('FAIL:', p);
  console.log(`Итого нарушений: ${problems.length} (файлов в dist: ${files.length})`);
  process.exit(1);
}
console.log(`OK: dist — ${files.length} файлов, админки и запрещённых маркеров нет`);
