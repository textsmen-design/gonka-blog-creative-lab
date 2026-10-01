// tools/admin/bindings.mjs — сверка «шаблон ↔ JSON».
// Парсит выражения {S[...]}/{L.*}/{M.*}/{site.*} в шаблонах и проверяет:
//  1) каждая ссылка резолвится в данные — иначе ошибка (шаблон сломается);
//  2) элемент массива данных не упомянут в шаблоне — предупреждение (заморозка);
//  3) лист данных не используется — предупреждение (мёртвое поле).
// W0/W1 и хардкод-узлы (поля, отсутствующие в JSON) ошибками не считаются.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, FILE_NAMES, readAll } from './store.mjs';

const ROOTS = {
  S: ['sections'],
  L: ['links'],
  M: ['media', 'previews'],
  site: ['site'],
  // index.astro: const title = site.meta.title; const description = site.meta.description;
  title: ['site', 'meta', 'title'],
  description: ['site', 'meta', 'description'],
};

function bodyOf(source) {
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('---', 3);
  const after = end === -1 ? 0 : end + 3;
  const style = source.indexOf('<style', after);
  return source.slice(after, style === -1 ? undefined : style);
}

function parseExpr(expr) {
  const e = expr.slice(1, -1).trim();
  if (e === '' || e === 'W0' || e === 'W1') return null;
  const m = e.match(/^(\w+)((?:\[[^\]]*\]|\.[$\w]+)*)$/);
  if (!m) return null;
  const toks = [...(m[2] || '').matchAll(/\[('|\")?([^\]'"]*)\1?\]|\.([$\w]+)/g)]
    .map((t) => (t[2] !== undefined && t[2] !== '' ? t[2] : t[3]))
    .filter((t) => t !== undefined);
  return { root: m[1], tokens: toks };
}

function markLeaves(obj, prefix, out) {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => markLeaves(v, [...prefix, String(i)], out));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) markLeaves(v, [...prefix, k], out);
  } else {
    out.add(prefix.join('.'));
  }
}

function walkPath(data, fullPath) {
  let node = data;
  const arrIdx = []; // {arrPath, index}
  const acc = [];
  for (const seg of fullPath) {
    if (node === undefined || node === null) return { missing: seg, arrIdx };
    acc.push(seg);
    if (Array.isArray(node)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= node.length) return { missing: seg, arrIdx };
      arrIdx.push({ arrPath: acc.slice(0, -1).join('.'), index: i });
      node = node[i];
    } else if (typeof node === 'object') {
      if (!(seg in node)) return { missing: seg, arrIdx };
      node = node[seg];
    } else {
      return { missing: seg, arrIdx };
    }
  }
  return { node, arrIdx };
}

export function checkBindings({ data, component, page } = {}) {
  const errors = [];
  const warnings = [];
  const d = data || readAll();
  const compPath = component || path.join(ROOT, 'src', 'components', 'SpatialWorkbench.astro');
  const pagePath = page || path.join(ROOT, 'src', 'pages', 'index.astro');
  const texts = [
    fs.readFileSync(compPath, 'utf8'),
    fs.readFileSync(pagePath, 'utf8'),
  ];

  const usedLeaves = new Set();
  const usedArrayIdx = new Map(); // "секции.модал.blocks" -> Set(индексы)
  const stats = { expr: 0, resolved: 0, skipped: 0 };

  for (const source of texts) {
    const body = bodyOf(source);
    const exprs = new Set(body.match(/\{[^{}]+\}/g) || []);
    for (const expr of exprs) {
      const parsed = parseExpr(expr);
      if (!parsed) { stats.skipped += 1; continue; }
      const base = ROOTS[parsed.root];
      if (!base) { stats.skipped += 1; continue; }
      stats.expr += 1;
      const fullPath = [...base, ...parsed.tokens];
      const res = walkPath(d, fullPath);
      for (const { arrPath, index } of res.arrIdx) {
        if (!usedArrayIdx.has(arrPath)) usedArrayIdx.set(arrPath, new Set());
        usedArrayIdx.get(arrPath).add(index);
      }
      if (res.missing !== undefined) {
        errors.push({
          path: fullPath.join('.'),
          message: `ссылка из шаблона не резолвится (нет «${res.missing}») — ${expr}`,
        });
        continue;
      }
      stats.resolved += 1;
      if (res.node !== null && typeof res.node === 'object') markLeaves(res.node, fullPath, usedLeaves);
      else usedLeaves.add(fullPath.join('.'));
    }
  }

  // неиспользуемые листья
  const allLeaves = new Set();
  for (const name of FILE_NAMES) markLeaves(d[name], [name], allLeaves);
  for (const leaf of allLeaves) {
    if (!usedLeaves.has(leaf)) {
      warnings.push({ path: leaf, message: 'данные не используются в шаблоне (мёртвое поле)' });
    }
  }

  // неиспользуемые элементы массивов
  for (const [arrPath, idxSet] of usedArrayIdx) {
    const node = walkPath(d, arrPath.split('.')).node;
    if (!Array.isArray(node)) continue;
    node.forEach((_, i) => {
      if (!idxSet.has(i)) {
        warnings.push({ path: `${arrPath}[${i}]`, message: 'элемент массива не упомянут в шаблоне (структура заморожена)' });
      }
    });
  }

  return { errors, warnings, stats };
}
