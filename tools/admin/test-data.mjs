#!/usr/bin/env node
// tools/admin/test-data.mjs — изолированные проверки модели данных (этап 4a): схемы, правила, привязки, API на временной копии.
// Ничего не пишет в src/data: API-часть работает на копии во временной папке (ADMIN_DATA_DIR) и своём порту.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gonka-data-'));
fs.mkdirSync(path.join(tmp, 'data'));
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'data')).filter((x) => x.endsWith('.json'))) fs.copyFileSync(path.join(ROOT, 'src', 'data', f), path.join(tmp, 'data', f));
process.env.ADMIN_DATA_DIR = path.join(tmp, 'data');
process.env.ADMIN_AUDIT_FILE = path.join(tmp, 'audit.log');
process.env.ADMIN_TOKEN = 'test-token-0123456789abcdef-isolated';
process.env.ADMIN_PORT = '4337';

const { readAll, FILE_NAMES } = await import('./store.mjs');
const { validateFile } = await import('./validate.mjs');
const { checkBindings } = await import('./bindings.mjs');
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const clone = (v) => JSON.parse(JSON.stringify(v));
const base = readAll();
const errs = (file, data) => validateFile(file, data).errors.map((e) => `${e.path}: ${e.message}`);
const bind = (data) => checkBindings({ data }).errors.map((e) => `${e.path}: ${e.message}`);

check('файлы данных: site, links, media, sections, projects, scene', JSON.stringify(FILE_NAMES) === JSON.stringify(['site', 'links', 'media', 'sections', 'projects', 'scene']));
for (const f of FILE_NAMES) check(`${f}.json валиден по схеме`, errs(f, base[f]).length === 0, errs(f, base[f]).slice(0, 2).join('; '));
const b0 = checkBindings({ data: base });
check('привязки шаблон↔данные: 0 ошибок, 0 предупреждений', b0.errors.length === 0 && b0.warnings.length === 0, `${b0.errors.length}/${b0.warnings.length}`);

// --- соцсети ---
let d = clone(base.links); d.socials[0].url = 'javascript:alert(1)';
check('соцсети: javascript: запрещён', errs('links', d).some((e) => /socials\[0\]\.url/.test(e)));
d = clone(base.links); d.socials = d.socials.filter((x) => x.id !== 'telegram');
check('соцсети: нельзя удалить telegram (используется в кнопках разделов)', errs('links', d).some((e) => /telegram/.test(e)));
d = clone(base.links); d.socials.push({ ...d.socials[2], label: 'Копия' });
check('соцсети: повторяющийся id отклоняется', errs('links', d).some((e) => /повторяющийся id/.test(e)));
d = clone(base.links); d.socials[2].icon = 'tiktok';
check('соцсети: иконка вне белого списка отклоняется', errs('links', d).length > 0);
d = clone(base.links); d.socials[1].newTab = true;
check('соцсети: «в новой вкладке» только для https', errs('links', d).some((e) => /newTab/.test(e)));
d = clone(base.links); d.socials[3].enabled = false; d.socials.push({ id: 'github', label: 'GitHub', url: 'https://github.com/example', enabled: true, icon: 'link', newTab: true, title: 'GitHub', ariaLabel: 'GitHub профиль' });
check('соцсети: отключение и новая сеть допустимы', errs('links', d).length === 0);
d = clone(base.links); d.socials[0].extra = 'x';
check('соцсети: неизвестное поле отклоняется', errs('links', d).length > 0);

// --- боты ---
let p = clone(base.projects); p.bots[0].botUrl = 'http://t.me/x';
check('боты: опубликованный бот требует https-ссылку', errs('projects', p).some((e) => /botUrl/.test(e)));
p = clone(base.projects); p.bots[1].drawerId = p.bots[0].drawerId;
check('боты: повторяющийся drawerId отклоняется', errs('projects', p).some((e) => /drawerId/.test(e)));
p = clone(base.projects); p.bots[0].screenPreview = '/previews/нет-такого.png';
check('боты: превью вне allowlist/несуществующее отклоняется', errs('projects', p).length > 0);
p = clone(base.projects); p.bots.push({ ...clone(p.bots[0]), id: 'new-bot', drawerId: 'modal-new-bot', name: 'Новый бот', status: 'draft' });
check('боты: новый бот в статусе черновика допустим', errs('projects', p).length === 0, errs('projects', p).join('; '));
p = clone(base.projects); delete p.bots[0].name;
check('боты: имя обязательно', errs('projects', p).length > 0);
p = clone(base.projects); p.bots[0].blocks.pop();
check('боты: неполные блоки досье отклоняются (иначе сборка упала бы)', errs('projects', p).some((e) => /blocks/.test(e)));
p = clone(base.projects); p.bots[0].actions = ['только одна'];
check('боты: неверное число подписей кнопок отклоняется', errs('projects', p).some((e) => /actions/.test(e)));

// --- предметы сцены ---
let sc = clone(base.scene); sc.items[0].target = 'modal-нет';
check('сцена: неверный формат цели отклоняется схемой', errs('scene', sc).length > 0);
sc = clone(base.scene); sc.items[0].target = 'modal-doesnotexist';
check('сцена: несуществующая панель ловится сверкой привязок', bind({ ...base, scene: sc }).some((e) => /scene\.items\[0\]\.target/.test(e)));
sc = clone(base.scene); sc.items[1].tipKey = 'modal-unknown';
check('сцена: несуществующий ключ подсказки ловится сверкой', bind({ ...base, scene: sc }).some((e) => /tipKey/.test(e)));
sc = clone(base.scene); sc.items.pop();
check('сцена: состав предметов фиксирован (нельзя удалить)', errs('scene', sc).length > 0);
sc = clone(base.scene); sc.items[1].id = sc.items[0].id;
check('сцена: повторяющийся предмет отклоняется', errs('scene', sc).some((e) => /повторяющийся предмет|значение вне/.test(e)));
sc = clone(base.scene); sc.items[2].visible = false; sc.items.reverse();
check('сцена: скрытие и смена порядка допустимы', errs('scene', sc).length === 0 && bind({ ...base, scene: sc }).length === 0);
sc = clone(base.scene); sc.items[0].label = 'x'.repeat(200);
check('сцена: слишком длинная подпись отклоняется', errs('scene', sc).length > 0);

// --- согласованность кода и данных ---
const { objects } = await import('../../src/scene/objects.mjs');
check('сцена: ids в scene.json = ids контуров в коде', JSON.stringify(base.scene.items.map((i) => i.id).sort()) === JSON.stringify(objects.map((o) => o.id).sort()));
const schemaIds = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/admin/schema/scene.schema.json'), 'utf8')).$defs.item.properties.id.enum;
check('сцена: enum в схеме = ids контуров в коде', JSON.stringify([...schemaIds].sort()) === JSON.stringify(objects.map((o) => o.id).sort()));

// --- API на временной копии (изолированный сервер) ---
const srv = spawn(process.execPath, [path.join(ROOT, 'tools/admin/server.mjs')], { env: process.env, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const H = { 'X-Admin-Token': process.env.ADMIN_TOKEN, 'Content-Type': 'application/json' };
const api = async (url, opt = {}) => { const r = await fetch('http://127.0.0.1:4337' + url, { ...opt, headers: { ...H, ...(opt.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
try {
  const g = await api('/api/data');
  check('API: /api/data отдаёт 6 файлов, включая scene', g.status === 200 && Object.keys(g.body.data).length === 6 && !!g.body.etags.scene, Object.keys(g.body.data).join(','));
  const sceneNew = clone(g.body.data.scene); sceneNew.items[0].label = 'Лампа (тест)';
  const ok = await api('/api/save', { method: 'POST', body: JSON.stringify({ file: 'scene', data: sceneNew, ifMatch: g.body.etags.scene }) });
  check('API: сохранение scene.json', ok.status === 200, JSON.stringify(ok.body).slice(0, 120));
  const bad = clone(sceneNew); bad.items[0].target = 'modal-doesnotexist';
  const rej = await api('/api/save', { method: 'POST', body: JSON.stringify({ file: 'scene', data: bad, ifMatch: ok.body?.etag }) });
  check('API: сохранение scene с несуществующей панелью → 422', rej.status === 422, String(rej.status));
  const badLinks = clone(g.body.data.links); badLinks.socials[0].url = 'javascript:alert(1)';
  const rej2 = await api('/api/save', { method: 'POST', body: JSON.stringify({ file: 'links', data: badLinks, ifMatch: g.body.etags.links }) });
  check('API: сохранение links с javascript: → 422', rej2.status === 422, String(rej2.status));
  const real = fs.readFileSync(path.join(ROOT, 'src/data/scene.json'), 'utf8');
  check('изоляция: реальный src/data/scene.json не изменён тестом', !real.includes('Лампа (тест)'));
} finally { srv.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }

console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
