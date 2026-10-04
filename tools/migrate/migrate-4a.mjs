#!/usr/bin/env node
// tools/migrate/migrate-4a.mjs — миграция данных этапа 4a (боты → projects.bots, соцсети → links.socials, scene.json).
// Режимы:
//   node tools/migrate/migrate-4a.mjs plan  <backupDir> <outDir>   — строит новые JSON в outDir, проверяет без потерь, ничего не пишет в src/data
//   node tools/migrate/migrate-4a.mjs apply <backupDir>             — то же + записывает в src/data (только если текущие файлы совпадают с backupDir по sha256)
// Исходные данные ВСЕГДА читаются из резервной копии (backupDir), поэтому скрипт повторяем и безопасен.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'src', 'data');
const [mode, backupDir, outArg] = process.argv.slice(2);
if (!['plan', 'apply'].includes(mode) || !backupDir) { console.error('usage: migrate-4a.mjs plan <backupDir> <outDir> | apply <backupDir>'); process.exit(2); }
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const read = (name) => JSON.parse(fs.readFileSync(path.join(backupDir, name + '.json'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

const src = { site: read('site'), links: read('links'), media: read('media'), sections: read('sections'), projects: read('projects') };
if (src.projects.bots || src.links.socials) { console.error('Данные уже мигрированы (есть projects.bots или links.socials) — остановка.'); process.exit(3); }

// ---------- боты ----------
const BOT_DEFS = [
  { id: 'myasnaya-troitsa', drawerId: 'modal-myasnaya-troitsa', cardIndex: 0, linkKey: 'myasnayaTroitsa', accent: 'emerald', cardClass: 'bot-card-meat',
    screenAlt: 'Мясная Троица — Telegram-бот', launchTitle: 'Запустить бота @myasnaya_troitsa_bot в Telegram' },
  { id: 'bot-detective', drawerId: 'modal-aichatbot', cardIndex: 1, linkKey: 'botDetective', accent: 'purple', cardClass: 'bot-card-detective',
    screenAlt: 'Бот Детектив — интерактивные детективные истории', launchTitle: 'Запустить бота @AI_CH_BOT_univers_bot в Telegram' },
];
const bots = BOT_DEFS.map((d) => {
  const card = src.sections['modal-bots'].cards[d.cardIndex];
  const dos = src.sections[d.drawerId];
  assert.equal(dos.hero.title, card.name, `hero.title ≠ name для ${d.id}`);
  return {
    id: d.id, type: 'bot', drawerId: d.drawerId, status: 'published',
    name: card.name, accent: d.accent, cardClass: d.cardClass, badge: card.badge,
    screenBadge: card.screenBadge, screenPreview: src.media.previews[d.linkKey], screenAlt: d.screenAlt,
    catalogDesc: card.desc, catalogSections: clone(card.sections), catalogActions: clone(card.actions),
    botUrl: src.links[d.linkKey], launchTitle: d.launchTitle,
    headerTag: dos.header.tag, headerBadge: dos.header.badge, heroStatus: dos.hero.status, lead: dos.hero.lead,
    actions: clone(dos.actions), blocks: clone(dos.blocks),
  };
});

// ---------- соцсети ----------
const SOCIAL_DEFS = [
  { id: 'telegram', label: 'Telegram', icon: 'telegram', newTab: true, title: 'Telegram (@lonelysvobodny)', ariaLabel: 'Связаться в Telegram: @lonelysvobodny' },
  { id: 'email', label: 'Email', icon: 'email', newTab: false, title: 'Email (textsmen@gmail.com)', ariaLabel: 'Написать на почту: textsmen@gmail.com' },
  { id: 'youtube', label: 'YouTube', icon: 'youtube', newTab: false, title: 'YouTube канал (в разработке)', ariaLabel: 'YouTube канал GONKA.BLOG (в разработке)' },
  { id: 'instagram', label: 'Instagram', icon: 'instagram', newTab: false, title: 'Instagram профиль (в разработке)', ariaLabel: 'Instagram профиль GONKA.BLOG (в разработке)' },
];
const socials = SOCIAL_DEFS.map((d) => ({ id: d.id, label: d.label, url: src.links[d.id], enabled: true, icon: d.icon, newTab: d.newTab, title: d.title, ariaLabel: d.ariaLabel }));

// ---------- scene.json (подписи/разделы/видимость/порядок; контуры остаются в коде) ----------
const objects = (await import(path.join(ROOT, 'src', 'scene', 'objects.mjs') + '?v=' + Date.now())).objects;
const legacyScene = JSON.parse(fs.readFileSync(path.join(backupDir, 'scene-legacy.json'), 'utf8')); // снимок label/target/tip из объектов кода до миграции
assert.deepEqual(legacyScene.map((o) => o.id), objects.map((o) => o.id), 'состав предметов в коде и в снимке не совпал');
const scene = { schemaVersion: 1, items: legacyScene.map((o) => ({ id: o.id, label: o.label, target: o.target, tipKey: o.tip || '', visible: true })) };

// ---------- новые файлы ----------
const next = clone(src);
for (const k of ['telegram', 'email', 'youtube', 'instagram', 'myasnayaTroitsa', 'botDetective']) delete next.links[k];
next.links = { socials, ...next.links };
for (const k of ['myasnayaTroitsa', 'botDetective']) delete next.media.previews[k];
delete next.sections['modal-myasnaya-troitsa']; delete next.sections['modal-aichatbot'];
delete next.sections['modal-bots'].cards;
next.projects = { ...next.projects, bots };
next.scene = scene;

// ---------- проверка «без потерь»: обратная сборка прежних структур ----------
const back = { links: clone(next.links), media: clone(next.media), sections: clone(next.sections) };
for (const s of back.links.socials) back.links[s.id] = s.url; delete back.links.socials;
for (const [i, b] of next.projects.bots.entries()) {
  const d = BOT_DEFS[i];
  back.links[d.linkKey] = b.botUrl; back.media.previews[d.linkKey] = b.screenPreview;
  back.sections[b.drawerId] = { header: { tag: b.headerTag, badge: b.headerBadge }, hero: { status: b.heroStatus, title: b.name, lead: b.lead }, actions: b.actions, blocks: b.blocks };
  (back.sections['modal-bots'].cards ||= [])[i] = { sections: b.catalogSections, actions: b.catalogActions, screenBadge: b.screenBadge, name: b.name, badge: b.badge, desc: b.catalogDesc };
}
const report = [];
for (const f of ['links', 'media', 'sections']) {
  const ok = canon(back[f]) === canon(src[f]);
  report.push(`${ok ? 'OK ' : 'FAIL'} обратная сборка ${f}.json совпадает с исходным`);
  if (!ok) { console.log(report.join('\n')); process.exit(4); }
}
assert.equal(canon(next.site), canon(src.site)); assert.equal(canon({ slots: next.projects.slots, landings: next.projects.landings, trackers: next.projects.trackers }), canon(src.projects));
report.push('OK  site.json не изменён; projects.slots/landings/trackers не изменены');
const values = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => values(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => values(x, out)); return out; };
const textsBefore = values([src.sections['modal-bots'], src.sections['modal-myasnaya-troitsa'], src.sections['modal-aichatbot']]);
const afterSet = new Set(values([next.sections['modal-bots'], next.projects.bots]));
const lost = [...new Set(textsBefore)].filter((t) => !afterSet.has(t));
const merged = textsBefore.length - new Set(textsBefore).size; // одинаковые строки, которые раньше хранились дважды (hero.title и name бота)
report.push(`${lost.length ? 'FAIL' : 'OK '} строковых значений текста ботов: ${textsBefore.length}, потеряно: ${lost.length}, объединено дублей: ${merged}${lost.length ? ' → ' + lost.join(' | ') : ''}`);
console.log(report.join('\n'));
if (lost.length) process.exit(5);

const outDir = mode === 'plan' ? outArg : DATA;
if (mode === 'plan') fs.mkdirSync(outDir, { recursive: true });
if (mode === 'apply') {
  const sums = fs.readFileSync(path.join(backupDir, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/\s+/));
  for (const [h, f] of sums.filter(([, f]) => ['site.json', 'links.json', 'media.json', 'sections.json', 'projects.json'].includes(f))) {
    if (sha(fs.readFileSync(path.join(DATA, f))) !== h) { console.error(`STOP: ${f} изменён после резервной копии — миграция отменена, чтобы не затереть правки.`); process.exit(6); }
  }
}
for (const name of ['links', 'media', 'sections', 'projects', 'scene']) {
  const target = path.join(outDir, name + '.json');
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next[name], null, 2) + '\n');
  fs.renameSync(tmp, target);
}
console.log(`записано в ${path.relative(ROOT, outDir) || '.'}: links, media, sections, projects, scene`);
