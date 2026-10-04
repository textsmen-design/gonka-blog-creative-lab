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
  P: ['projects'],
  projects: ['projects'],
  // index.astro: const title = site.meta.title; const description = site.meta.description;
  title: ['site', 'meta', 'title'],
  description: ['site', 'meta', 'description'],
};

function bodyOf(source) {
  if (!source.startsWith('---')) return source;
  const m = source.slice(3).match(/\n---[ \t]*\r?\n/);
  const after = m ? 3 + m.index + m[0].length : 0;
  const style = source.indexOf('<style', after);
  return source.slice(after, style === -1 ? undefined : style);
}

// Обращения к данным внутри frontmatter (циклы и сборка сцены): S[..], L.., site.desk[..], P.. и т.п.
function frontmatterRefs(source) {
  if (!source.startsWith('---')) return [];
  const m = source.slice(3).match(/\n---[ \t]*\r?\n/);
  if (!m) return [];
  const fm = source.slice(3, 3 + m.index)
    .split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
    .replace(/\/\/[^\n]*/g, '');
  const rootKeys = Object.keys(ROOTS).join('|');
  return [...fm.matchAll(new RegExp(`(?<![.\\w$])(${rootKeys})((?:\\[[^\\]]+\\]|\\.[$\\w]+)+)`, 'g'))].map((x) => `{${x[0].replace(/\.(find|filter|map|some|every|reduce|forEach|includes|flatMap|length|entries|keys|values)\b.*$/, '')}}`);
}

function parseExpr(expr) {
  const e = expr.slice(1, -1).trim();
  if (e === '' || e === 'W0' || e === 'W1') return [];
  const direct = e.match(/^(\w+)((?:\[[^\]]*\]|\.[$\w]+)*)$/);
  if (direct) {
    const toks = [...(direct[2] || '').matchAll(/\[('|\")?([^\]'"]*)\1?\]|\.([$\w]+)/g)]
      .map((t) => (t[2] !== undefined && t[2] !== '' ? t[2] : t[3]))
      .filter((t) => t !== undefined);
    return [{ root: direct[1], tokens: toks }];
  }
  const rootKeys = Object.keys(ROOTS).join('|');
  const subMatches = [...e.matchAll(new RegExp(`\\b(${rootKeys})((?:\\[[^\\]]+\\]|\\.[$\\w]+)+)`, 'g'))];
  if (!subMatches.length) return [];
  return subMatches.map((m) => {
    const toks = [...(m[2] || '').matchAll(/\[('|\")?([^\]'"]*)\1?\]|\.([$\w]+)/g)]
      .map((t) => (t[2] !== undefined && t[2] !== '' ? t[2] : t[3]))
      .filter((t) => t !== undefined);
    return { root: m[1], tokens: toks };
  });
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

// L.telegram и т.п. в шаблоне — это URL соцсети из links.socials[] (единый источник данных)
function deriveLinks(links) {
  const view = { ...links };
  const alias = new Map();
  (links.socials || []).forEach((s, i) => { if (s && s.id && !(s.id in view)) { view[s.id] = s.url; alias.set(s.id, `links.socials.${i}.url`); } });
  return { view, alias };
}

export function checkBindings({ data, component, page } = {}) {
  const errors = [];
  const warnings = [];
  const d0 = data || readAll();
  const { view: linksView, alias: socialAlias } = deriveLinks(d0.links || {});
  const d = { ...d0, links: linksView };
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
    const exprs = new Set([...(body.match(/\{[^{}]+\}/g) || []), ...frontmatterRefs(source)]);
    for (const expr of exprs) {
      const parsedList = parseExpr(expr);
      if (!parsedList.length) { stats.skipped += 1; continue; }
      for (const parsed of parsedList) {
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
        if (parsed.root === 'L' && socialAlias.has(parsed.tokens[0])) { usedLeaves.add(socialAlias.get(parsed.tokens[0])); continue; }
        if (res.node !== null && typeof res.node === 'object') markLeaves(res.node, fullPath, usedLeaves);
        else usedLeaves.add(fullPath.join('.'));
      }
    }
  }

  // неиспользуемые листья (для статически связанных файлов)
  const allLeaves = new Set();
  for (const name of FILE_NAMES) {
    if (name === 'projects' || name === 'scene') continue; // projects/scene рендерятся в коде (циклы и сцена), поля проверяются схемой
    markLeaves(d0[name], [name], allLeaves);
  }
  const migratedPrefixes = [
    'sections.modal-english-teacher',
    'sections.modal-twohearts',
    'sections.modal-siteviza',
    'sections.modal-atelier',
    'sections.modal-landasset5',
    'sections.modal-tracker01',
    'sections.modal-sites.cards',
    'site.chips',
    'links.english',
    'links.twohearts',
    'links.siteviza',
    'links.atelier',
    'links.landasset5',
    'links.tracker01',
    'media.previews.englishTeacher',
    'media.previews.twohearts',
    'media.previews.siteviza',
    'media.previews.atelier',
    'media.previews.landasset5',
    'media.previews.tracker01',
    'site.topbar.brandSub',
    'site.footer',
  ];
  for (const leaf of allLeaves) {
    if (migratedPrefixes.some((p) => leaf === p || leaf.startsWith(p + '.'))) continue;
    if (!usedLeaves.has(leaf)) {
      warnings.push({ path: leaf, message: 'данные не используются в шаблоне (мёртвое поле)' });
    }
  }

  // сцена: цели предметов и ключи подсказок должны существовать
  if (d0.scene && Array.isArray(d0.scene.items)) {
    const known = new Set();
    for (const t of texts) for (const m of t.matchAll(/<aside id="(modal-[a-z0-9-]+)"/g)) known.add(m[1]);
    for (const k of Object.keys(d0.sections || {})) if (k.startsWith('modal-')) known.add(k);
    for (const sl of d0.projects?.slots || []) known.add('modal-slot-' + sl.slotId);
    for (const l of d0.projects?.landings || []) known.add(l.drawerId || 'modal-landing-' + l.id);
    for (const tr of d0.projects?.trackers || []) known.add(tr.drawerId || 'modal-' + tr.id);
    for (const b of d0.projects?.bots || []) if (b.drawerId) known.add(b.drawerId);
    const deskKeys = new Set(Object.keys(d0.site?.desk || {}));
    d0.scene.items.forEach((it, i) => {
      if (!known.has(it.target)) errors.push({ path: `scene.items[${i}].target`, message: `панель «${it.target}» не существует` });
      if (it.tipKey && !deskKeys.has(it.tipKey)) errors.push({ path: `scene.items[${i}].tipKey`, message: `нет текста подсказки site.desk.${it.tipKey}` });
    });
  }

  // неиспользуемые элементы массивов
  for (const [arrPath, idxSet] of usedArrayIdx) {
    if (arrPath.startsWith('projects')) continue;
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
