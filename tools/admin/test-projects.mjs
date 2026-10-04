#!/usr/bin/env node
// tools/admin/test-projects.mjs — проверки этапа 4b: архив, восстановление, дубликаты, окончательное удаление, поиск, целостность,
// серверная защита от потери, интерфейс админки (CDP). Работает на ВРЕМЕННОЙ копии данных (ADMIN_DATA_DIR), реальные файлы не трогает.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gonka-projects-'));
fs.mkdirSync(path.join(tmp, 'data'));
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'data')).filter((x) => x.endsWith('.json'))) fs.copyFileSync(path.join(ROOT, 'src', 'data', f), path.join(tmp, 'data', f));
const realProjectsBefore = fs.readFileSync(path.join(ROOT, 'src/data/projects.json'), 'utf8');
const TOKEN = 'test-token-0123456789abcdef-projects';
process.env.ADMIN_DATA_DIR = path.join(tmp, 'data'); process.env.ADMIN_AUDIT_FILE = path.join(tmp, 'audit.log'); process.env.ADMIN_TOKEN = TOKEN; process.env.ADMIN_PORT = '4339';

const ops = await import('./lib/project-ops.mjs');
const { validateFile } = await import('./validate.mjs');
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const clone = (v) => JSON.parse(JSON.stringify(v));
const base = clone(JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/projects.json'), 'utf8')));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ===== A. Операции (в памяти) =====
{
  const P = clone(base);
  const land = P.landings[0];
  const before = clone(land);
  // слот: назначаем лендинг на «лампу»
  P.slots[0].assigned = true; P.slots[0].assignedProjectId = land.id; P.slots[0].project = clone(land);
  let r = ops.archiveProject(P, 'landings', land.id, '2026-10-03T10:00:00.000Z');
  check('архив: статус archived, prevStatus и дата сохранены', r.ok && land.status === 'archived' && land.prevStatus === before.status && land.archivedAt === '2026-10-03T10:00:00.000Z');
  check('архив: слот освобождён, слот запомнен для восстановления', r.slotCleared === P.slots[0].slotId && !P.slots[0].assigned && land.archivedSlotId === P.slots[0].slotId);
  check('архив: содержимое проекта (текст, блоки, ссылки) не изменилось', eq({ ...land, status: before.status, prevStatus: undefined, archivedAt: undefined, archivedSlotId: undefined }, { ...before, prevStatus: undefined, archivedAt: undefined, archivedSlotId: undefined }));
  check('архив: повторная архивация отклоняется', ops.archiveProject(P, 'landings', land.id).ok === false);
  check('архив: проект не пропал из массива (количество то же)', P.landings.length === base.landings.length);
  r = ops.restoreProject(P, 'landings', land.id);
  check('восстановление: прежний статус, служебные поля убраны', r.ok && land.status === before.status && !('prevStatus' in land) && !('archivedAt' in land) && !('archivedSlotId' in land));
  check('восстановление: слот возвращён, если был свободен', r.restoredSlot === P.slots[0].slotId && P.slots[0].assigned && P.slots[0].project.id === land.id);
  check('архив → восстановление: проект побайтово как исходный', eq(land, before));
  // восстановление при занятом слоте
  ops.archiveProject(P, 'landings', land.id);
  P.slots[0].assigned = true; P.slots[0].assignedProjectId = 'other'; P.slots[0].project = { id: 'other', name: 'Другой' };
  r = ops.restoreProject(P, 'landings', land.id);
  check('восстановление: занятый слот не перезаписывается', r.ok && r.slotBusy === P.slots[0].slotId && P.slots[0].assignedProjectId === 'other');
  P.slots[0].assigned = false; P.slots[0].assignedProjectId = null; P.slots[0].project = null;

  const Q = clone(base);
  const orig = clone(Q.bots[0]);
  r = ops.duplicateProject(Q, 'bots', Q.bots[0].id);
  const dup = Q.bots[r.index];
  check('дубликат: уникальные id и drawerId, статус «черновик», имя «(копия)»', r.ok && dup.id !== orig.id && dup.drawerId !== orig.drawerId && dup.status === 'draft' && dup.name === orig.name + ' (копия)', `${dup.id} / ${dup.drawerId}`);
  check('дубликат: оригинал не изменён, копия стоит сразу после него', eq(Q.bots[0], orig) && r.index === 1);
  check('дубликат: копия независима (правка копии не меняет оригинал)', (() => { dup.blocks[0].text = 'ИЗМЕНЕНО'; dup.catalogSections[1].items.push('x'); return eq(Q.bots[0], orig); })());
  const r2 = ops.duplicateProject(Q, 'bots', Q.bots[0].id), r3 = ops.duplicateProject(Q, 'bots', Q.bots[0].id);
  check('дубликат: повторные копии получают разные id (-copy, -copy-2, …)', new Set(ops.allProjects(Q).map((x) => x.item.id)).size === ops.allProjects(Q).length && r2.ok && r3.ok, Q.bots.map((b) => b.id).join(', '));
  check('дубликат лендинга и трекера: уникальные панели', (() => { const L = clone(base); ops.duplicateProject(L, 'landings', L.landings[0].id); ops.duplicateProject(L, 'trackers', L.trackers[0].id); return ops.checkIntegrity(L).errors.length === 0; })());
  check('дубликат: проект из слота не копируется в слот', (() => { const L = clone(base); L.slots[1].assigned = true; L.slots[1].assignedProjectId = L.landings[0].id; L.slots[1].project = clone(L.landings[0]); ops.duplicateProject(L, 'landings', L.landings[0].id); return L.slots.filter((s) => s.assigned).length === 1; })());

  const D = clone(base);
  check('удаление навсегда: не из архива отклоняется', ops.deleteForever(D, 'bots', D.bots[0].id).ok === false && D.bots.length === base.bots.length);
  ops.archiveProject(D, 'bots', D.bots[0].id);
  r = ops.deleteForever(D, 'bots', D.bots[0].id);
  check('удаление навсегда: из архива удаляется, остальные боты целы', r.ok && D.bots.length === base.bots.length - 1 && eq(D.bots[0], base.bots[1]));
  check('удаление навсегда: ссылки слотов очищены', (() => { const L = clone(base); L.slots[2].assigned = true; L.slots[2].assignedProjectId = L.trackers[0].id; L.slots[2].project = clone(L.trackers[0]); ops.archiveProject(L, 'trackers', L.trackers[0].id); L.slots[2].assigned = true; L.slots[2].assignedProjectId = L.trackers[0].id; ops.deleteForever(L, 'trackers', L.trackers[0].id); return !L.slots[2].assigned && !L.slots[2].assignedProjectId; })());

  // поиск и фильтры
  const S = clone(base); ops.archiveProject(S, 'landings', S.landings[1].id); S.landings[2].status = 'draft';
  const names = (o) => ops.searchProjects(S, o).map((x) => x.item.name);
  check('поиск: по названию (без учёта регистра)', names({ q: 'ATELIER' }).some((n) => /atelier/i.test(n)) && names({ q: 'ATELIER' }).length >= 1);
  check('поиск: по ссылке и по описанию', ops.searchProjects(S, { q: 'siteviza.gonka.blog' }).length >= 1 && ops.searchProjects(S, { q: S.bots[0].catalogDesc.slice(0, 18) }).length >= 1);
  check('фильтр: по умолчанию архив скрыт, по статусу «Архив» виден', !names({}).includes(base.landings[1].name) && names({ status: 'archived' }).includes(base.landings[1].name));
  check('фильтр: по статусу «Черновики» и по группе', ops.searchProjects(S, { status: 'draft' }).every((x) => x.item.status === 'draft') && ops.searchProjects(S, { group: 'bots' }).every((x) => x.group === 'bots'));
  check('поиск: пустой результат для несуществующего', ops.searchProjects(S, { q: 'zzzнет-такого-qqq' }).length === 0);
  check('фильтр «Все» включает архив', ops.searchProjects(S, { status: 'all' }).length === ops.allProjects(S).length);

  // целостность
  const I = clone(base);
  check('целостность: исходные данные чистые (0 ошибок)', ops.checkIntegrity(I).errors.length === 0, JSON.stringify(ops.checkIntegrity(I).warnings).slice(0, 80));
  I.bots[1].id = I.bots[0].id;
  check('целостность: повторяющийся id — ошибка', ops.checkIntegrity(I).errors.some((e) => /повторяющийся id/.test(e.message)));
  const I2 = clone(base); I2.bots[1].drawerId = I2.bots[0].drawerId;
  check('целостность: повторяющийся drawerId — ошибка', ops.checkIntegrity(I2).errors.some((e) => /панели/.test(e.message)));
  const I3 = clone(base); I3.slots[0].assigned = true; I3.slots[0].assignedProjectId = I3.landings[0].id; I3.slots[0].project = clone(I3.landings[0]); I3.landings[0].status = 'archived'; I3.landings[0].archivedAt = 'x';
  check('целостность: архивный проект в слоте — ошибка', ops.checkIntegrity(I3).errors.some((e) => /в архиве/.test(e.message)));
  const I4 = clone(base); I4.slots[0].assigned = true; I4.slots[0].assignedProjectId = I4.landings[0].id; I4.slots[0].project = { ...clone(I4.landings[0]), lead: 'устарело' };
  check('целостность: устаревшая копия в слоте — предупреждение', ops.checkIntegrity(I4).warnings.some((e) => /отличается от каталога/.test(e.message)));
  const I5 = clone(base); I5.slots[0].assigned = true; I5.slots[0].assignedProjectId = 'нет-такого'; I5.slots[0].project = { id: 'нет-такого' };
  check('целостность: ссылка слота на несуществующий проект — предупреждение', ops.checkIntegrity(I5).warnings.some((e) => /нет в каталогах/.test(e.message)));
  check('защита: удаление неархивного проекта обнаруживается, удаление из архива — нет', (() => { const a = clone(base), b2 = clone(base); b2.landings.splice(0, 1); const lost = ops.findUnarchivedRemovals(a, b2); const a2 = clone(base); ops.archiveProject(a2, 'landings', a2.landings[0].id); const b3 = clone(a2); b3.landings.splice(0, 1); return lost.length === 1 && ops.findUnarchivedRemovals(a2, b3).length === 0; })());
  check('схема принимает проекты в архиве и служебные поля', (() => { const A = clone(base); ops.archiveProject(A, 'trackers', A.trackers[0].id); return validateFile('projects', A).errors.length === 0; })());
}

// ===== B. Сервер: защита от потери и целостность через API =====
const srv = spawn(process.execPath, [path.join(ROOT, 'tools/admin/server.mjs')], { env: process.env, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const H = { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' };
const api = async (url, opt = {}) => { const r = await fetch('http://127.0.0.1:4339' + url, { ...opt, headers: { ...H, ...(opt.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
let cdpBrowser = null;
try {
  let g = await api('/api/data');
  let etag = g.body.etags.projects;
  const save = async (data) => { const r = await api('/api/save', { method: 'POST', body: JSON.stringify({ file: 'projects', data, ifMatch: etag }) }); if (r.status === 200) etag = r.body.etag; return r; };
  let P = clone(g.body.data.projects);
  const victim = P.bots[1];
  const lost = clone(P); lost.bots.splice(1, 1);
  let r = await save(lost);
  check('API: удаление проекта без архивации отклонено (422) с понятным сообщением', r.status === 422 && /без архивации/.test(JSON.stringify(r.body)), String(r.status));
  check('API: после отказа файл не изменился', eq((await api('/api/data')).body.data.projects, g.body.data.projects));
  const arch = clone(P); ops.archiveProject(arch, 'bots', victim.id);
  r = await save(arch);
  check('API: архивирование сохраняется (200), резервная копия создана', r.status === 200 && !!r.body.backup, r.body?.backup);
  const rm = clone(arch); rm.bots.splice(1, 1);
  r = await save(rm);
  check('API: удаление уже архивного проекта разрешено (200)', r.status === 200, String(r.status));
  const dupId = clone(rm); dupId.landings[1].id = dupId.landings[0].id;
  r = await save(dupId);
  check('API: повторяющийся id отклонён (422)', r.status === 422 && /повторяющийся id/.test(JSON.stringify(r.body)));
  const dupFix = clone(rm); ops.duplicateProject(dupFix, 'landings', dupFix.landings[0].id);
  r = await save(dupFix);
  check('API: дубликат лендинга сохраняется (200)', r.status === 200, String(r.status));
  const arSlot = clone(dupFix); arSlot.slots[0].assigned = true; arSlot.slots[0].assignedProjectId = arSlot.landings[0].id; arSlot.slots[0].project = clone(arSlot.landings[0]); arSlot.landings[0].status = 'archived';
  r = await save(arSlot);
  check('API: архивный проект в плашке отклонён (422)', r.status === 422 && /в архиве/.test(JSON.stringify(r.body)));
  check('изоляция: реальный projects.json не изменён', fs.readFileSync(path.join(ROOT, 'src/data/projects.json'), 'utf8') === realProjectsBefore);

  // ===== D. Интерфейс админки (CDP) =====
  const { launch } = await import('../scene/cdp.mjs');
  // свежее состояние временных данных для UI-сценария
  for (const f of fs.readdirSync(path.join(ROOT, 'src', 'data')).filter((x) => x.endsWith('.json'))) fs.copyFileSync(path.join(ROOT, 'src', 'data', f), path.join(tmp, 'data', f));
  cdpBrowser = await launch({ width: 1300, height: 900, port: 9860 });
  const b = cdpBrowser;
  await b.goto('http://127.0.0.1:4339/', 400);
  await b.eval(`sessionStorage.setItem('gonka-admin-token', ${JSON.stringify(TOKEN)})`);
  await b.goto('http://127.0.0.1:4339/', 1500);
  await b.eval(`window.confirm = () => true; window.alert = (m) => { window.__alert = m; };`);
  const tab = (name) => b.eval(`[...document.querySelectorAll('#tabs button')].find(x => x.textContent === ${JSON.stringify(name)}).click()`).then(() => b.wait(400));
  const rows = () => b.eval(`JSON.stringify([...document.querySelectorAll('.landings-view:not([hidden]) .landing-row .landing-name, .trackers-view:not([hidden]) .landing-row .landing-name, .bots-view:not([hidden]) .landing-row .landing-name')].map(x => x.textContent))`).then(JSON.parse);
  const clickIn = (rowName, label) => b.eval(`(() => { const row = [...document.querySelectorAll('.landing-row')].find(r => r.querySelector('.landing-name').textContent === ${JSON.stringify(rowName)}); const btn = row && [...row.querySelectorAll('button')].find(x => x.textContent === ${JSON.stringify(label)}); if (!btn) return false; btn.click(); return true; })()`).then((v) => b.wait(350).then(() => v));
  const setStatusFilter = (v) => b.eval(`(() => { const s = document.querySelector('.pv-status'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change')); })()`).then(() => b.wait(300));
  const search = (q) => b.eval(`(() => { const i = document.querySelector('.pv-search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); })()`).then(() => b.wait(250));

  check('UI: вкладки «Лендинги», «Трекеры», «Боты» есть', (await b.eval(`[...document.querySelectorAll('#tabs button')].map(x => x.textContent).join('|')`)).includes('Боты'));
  await tab('Лендинги');
  const all0 = await rows();
  check('UI: список лендингов показан', all0.length === base.landings.length, all0.join(', '));
  await search('atelier');
  const found = await rows();
  check('UI: поиск «atelier» оставляет подходящие', found.length >= 1 && found.length < all0.length, found.join(', '));
  await search('');
  const target = base.landings[1].name;
  await clickIn(target, 'В архив');
  check('UI: «В архив» убирает проект из активного списка', !(await rows()).includes(target));
  await setStatusFilter('archived');
  check('UI: проект виден в фильтре «Архив» с кнопками «Восстановить» и «Удалить навсегда»', (await rows()).includes(target) && await b.eval(`[...document.querySelectorAll('.landing-row')].some(r => r.textContent.includes('Восстановить') && r.textContent.includes('Удалить навсегда'))`));
  await clickIn(target, 'Восстановить');
  await setStatusFilter('active');
  check('UI: «Восстановить» возвращает проект в активные', (await rows()).includes(target));
  await clickIn(target, 'Дублировать');
  const afterDup = await rows();
  check('UI: «Дублировать» создаёт «(копия)» сразу после оригинала', afterDup.includes(target + ' (копия)') && afterDup.indexOf(target + ' (копия)') === afterDup.indexOf(target) + 1, afterDup.join(' | '));
  check('UI: предпросмотр открывается и показывает название', await clickIn(target, 'Предпросмотр') && await b.eval(`!document.getElementById('preview-modal').hidden && document.getElementById('preview-body').textContent.includes(${JSON.stringify(target)})`));
  await b.eval(`document.getElementById('preview-close').click()`);
  // окончательное удаление копии: сначала архив, затем подтверждение вводом названия
  await clickIn(target + ' (копия)', 'В архив');
  await setStatusFilter('archived');
  await clickIn(target + ' (копия)', 'Удалить навсегда');
  const okDisabled = await b.eval(`document.getElementById('danger-ok').disabled`);
  await b.eval(`(() => { const i = document.getElementById('danger-input'); i.value = 'не то'; i.dispatchEvent(new Event('input')); })()`);
  const stillDisabled = await b.eval(`document.getElementById('danger-ok').disabled`);
  await b.eval(`(() => { const i = document.getElementById('danger-input'); i.value = ${JSON.stringify(target + ' (копия)')}; i.dispatchEvent(new Event('input')); })()`);
  const enabled = !(await b.eval(`document.getElementById('danger-ok').disabled`));
  check('UI: «Удалить навсегда» заблокировано, пока название не введено точно', okDisabled && stillDisabled && enabled);
  await b.eval(`document.getElementById('danger-ok').click()`); await b.wait(350);
  await setStatusFilter('all');
  check('UI: после подтверждения копия удалена, оригинал на месте', !(await rows()).includes(target + ' (копия)') && (await rows()).includes(target));
  // «Проверка целостности»
  await b.eval(`[...document.querySelectorAll('.pv-toolbar button')].find(x => x.textContent.includes('целостности')).click()`); await b.wait(300);
  check('UI: проверка целостности сообщает об отсутствии проблем', (await b.eval(`document.getElementById('notices').textContent`)).includes('проблем не найдено'));
  // сохранение: diff → подтверждение → файл на сервере
  await b.eval(`document.getElementById('btn-save').click()`); await b.wait(500);
  await b.eval(`document.getElementById('btn-confirm').click()`); await b.wait(1200);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'projects.json'), 'utf8'));
  check('UI: сохранение — проекты на месте, копия удалена, лишних нет', saved.landings.length === base.landings.length && saved.landings.every((l, i) => l.id === base.landings[i].id) && saved.bots.length === base.bots.length);
  check('UI: содержимое сохранённых проектов совпадает с исходным', eq(saved.landings, base.landings) && eq(saved.trackers, base.trackers) && eq(saved.bots, base.bots));

  // Боты
  await tab('Боты');
  const botNames = await rows();
  check('UI: вкладка «Боты» показывает обоих существующих ботов', botNames.length === 2 && botNames.includes('Мясная Троица') && botNames.includes('Бот Детектив'), botNames.join(', '));
  await b.eval(`[...document.querySelectorAll('.bots-view .landings-header button')].find(x => x.textContent.includes('Добавить')).click()`); await b.wait(400);
  const fill = (k, v) => b.eval(`(() => { const e = document.querySelector('#bot-fields [data-k="${k}"]'); e.value = ${JSON.stringify(v)}; })()`);
  await fill('name', 'Тестовый бот'); await fill('botUrl', 'http://t.me/x');
  await b.eval(`document.querySelector('#bot-form button[type=submit]').click()`); await b.wait(300);
  check('UI: бот с http-ссылкой не принимается (предупреждение), форма остаётся', String(await b.eval(`window.__alert || ''`)).includes('https://') && !(await b.eval(`document.getElementById('bot-modal').hidden`)));
  await fill('botUrl', 'https://t.me/test_bot'); await fill('catalogDesc', 'Описание теста'); await fill('lead', 'Лид теста');
  await b.eval(`document.getElementById('bot-preview-btn').click()`); await b.wait(300);
  check('UI: предпросмотр несохранённого бота показывает введённое', await b.eval(`document.getElementById('preview-body').textContent.includes('Тестовый бот') && document.getElementById('preview-body').textContent.includes('Описание теста')`));
  await b.eval(`document.getElementById('preview-close').click()`);
  await b.eval(`document.querySelector('#bot-form button[type=submit]').click()`); await b.wait(400);
  const bn = await rows();
  check('UI: новый бот добавлен в список (черновик)', bn.includes('Тестовый бот'), bn.join(', '));
  await b.eval(`document.getElementById('btn-save').click()`); await b.wait(500); await b.eval(`document.getElementById('btn-confirm').click()`); await b.wait(1200);
  const saved2 = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'projects.json'), 'utf8'));
  const nb = saved2.bots.find((x) => x.name === 'Тестовый бот');
  const notesText = await b.eval(`document.getElementById('notices').textContent`);
  check('UI: новый бот сохранён с уникальным id и drawerId, статус черновик, остальные боты не затронуты', !!nb && nb.status === 'draft' && /^modal-/.test(nb.drawerId) && nb.id !== saved2.bots[0].id && eq(saved2.bots.slice(0, 2), base.bots), nb ? `${nb.id} ${nb.drawerId}` : 'бот не сохранён; сообщения: ' + String(notesText).slice(0, 300));
  check('UI: сохранённые данные проходят серверную валидацию', validateFile('projects', saved2).errors.length === 0, JSON.stringify(validateFile('projects', saved2).errors.slice(0, 2)));
  check('UI: нет JS-ошибок', b.jsErrors().length === 0, b.jsErrors().join('; '));
  await b.shot('/tmp/gonka-projects-ui.png');
} finally {
  try { cdpBrowser?.close(); } catch { /* ignore */ }
  srv.kill();
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 1500);
}
console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
