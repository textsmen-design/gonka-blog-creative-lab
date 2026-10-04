#!/usr/bin/env node
// tools/admin/test-e2e-publish.mjs — сквозная проверка «админка → сохранение → публикация (сборка) → сайт после перезагрузки».
// Запускает ТОЧНУЮ копию админки и проекта во временной папке (свои данные, свой dist), реальные файлы проекта не меняются.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gonka-e2e-'));
const cpd = (rel, filter) => fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive: true, filter });
cpd('src', (s) => !s.includes('.backups') && !s.includes('.tmp') && !s.endsWith('.admin.lock'));
cpd('tools/admin', (s) => !s.includes('screenshots') && !s.endsWith('.token') && !s.endsWith('audit.log'));
for (const f of ['package.json', 'astro.config.mjs', 'tsconfig.json']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
cpd('public/scene'); cpd('public/previews');
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
const realHash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const realBefore = ['src/data/site.json', 'src/data/projects.json', 'src/data/media.json'].map(realHash);
const realDistBefore = fs.statSync(path.join(ROOT, 'dist/index.html')).mtimeMs;

const TOKEN = 'test-token-0123456789abcdef-e2e';
const env = { ...process.env, ADMIN_TOKEN: TOKEN, ADMIN_PORT: '4343' };
for (const k of ['ADMIN_DATA_DIR', 'ADMIN_PUBLIC_DIR', 'ADMIN_AUDIT_FILE', 'ADMIN_RELEASES_DIR', 'ADMIN_TOKEN_FILE', 'ADMIN_GIT_PUSH']) delete env[k];
const srv = spawn(process.execPath, [path.join(tmp, 'tools/admin/server.mjs')], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
await new Promise((r) => setTimeout(r, 1800));
let site = null;

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const ADMIN = 'http://127.0.0.1:4343', SITE = 'http://127.0.0.1:4344';
const H = { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' };
const api = async (u, o = {}) => { const r = await fetch(ADMIN + u, { ...o, headers: { ...H, ...(o.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const html = async () => (await fetch(SITE + '/?_=' + Date.now(), { cache: 'no-store' })).text();
let cdp = null;
try {
  check('копия админки работает на текущем коде (health v4) и из временной папки', (await (await fetch(ADMIN + '/api/health')).json()).apiVersion >= 4 && /данные: OK/.test(srvLog));
  site = spawn('python3', ['-m', 'http.server', '4344', '--bind', '127.0.0.1', '-d', path.join(tmp, 'dist')], { stdio: 'ignore' });
  const { launch } = await import('../scene/cdp.mjs');
  cdp = await launch({ width: 1300, height: 900, port: 9962 });
  await cdp.goto(ADMIN + '/', 500);
  await cdp.eval(`sessionStorage.setItem('gonka-admin-token', ${JSON.stringify(TOKEN)})`);
  await cdp.goto(ADMIN + '/', 1500);
  await cdp.eval(`window.confirm = () => true; window.alert = () => {};`);
  const fresh = async () => { await cdp.goto(ADMIN + '/', 800); await cdp.wait(1000); await cdp.eval(`window.confirm = () => true; window.alert = () => {};`); };
  const tab = (n) => cdp.eval(`[...document.querySelectorAll('#tabs button')].find(x => x.textContent === ${JSON.stringify(n)}).click()`).then(() => cdp.wait(500));
  const publish = async () => {
    await cdp.eval(`document.getElementById('btn-publish').click()`);
    await cdp.waitFor(`/Проект проверен и собран|Релиз|отклонена|Ошибка/.test(document.getElementById('notices').textContent)`, 120000);
    return cdp.eval(`document.getElementById('notices').textContent`);
  };
  const save = async () => { await cdp.eval(`document.getElementById('btn-save').click()`); await cdp.wait(500); await cdp.eval(`document.getElementById('btn-confirm').click()`); await cdp.wait(1200); return cdp.eval(`document.getElementById('notices').textContent`); };

  // --- 1. Правка текста на вкладке «Сайт» через форму ---
  const MARK = 'СТОЛ ПРОВЕРЕН ' + crypto.randomBytes(2).toString('hex').toUpperCase();
  await tab('Сайт');
  const orig = JSON.parse(fs.readFileSync(path.join(tmp, 'src/data/site.json'), 'utf8')).topbar.status;
  const set = await cdp.eval(`(() => { const t = [...document.querySelectorAll('#editor .field textarea')].find(x => x.value === ${JSON.stringify(orig)}); if (!t) return false; t.value = ${JSON.stringify(MARK)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  check('админка: поле «topbar.status» найдено и изменено в форме', set === true, orig);
  const noteSave = await save();
  check('админка: «Сохранить черновик» → файл на диске изменён, создана резервная копия', /Черновик успешно сохранён/.test(noteSave) && JSON.parse(fs.readFileSync(path.join(tmp, 'src/data/site.json'), 'utf8')).topbar.status === MARK && fs.readdirSync(path.join(tmp, 'src/data/.backups')).some((f) => f.startsWith('site.')), noteSave.slice(0, 60));
  const noteBuild = await publish();
  check('админка: «Опубликовать» → валидация, сборка и verify:dist прошли', /Проект проверен и собран|Релиз/.test(noteBuild), noteBuild.slice(0, 80));
  check('dist создан во временной копии и не содержит админки/токенов', fs.existsSync(path.join(tmp, 'dist/index.html')) && !fs.readFileSync(path.join(tmp, 'dist/index.html'), 'utf8').includes('X-Admin-Token'));
  const h1 = await html();
  check('сайт: изменённый текст виден в HTML после публикации', h1.includes(MARK));
  await cdp.goto(SITE + '/?theme=day', 600); await cdp.wait(1500);
  check('сайт: после перезагрузки страницы в браузере текст в верхней панели изменён', (await cdp.eval(`document.querySelector('.status-text')?.textContent`)) === MARK);
  await cdp.goto(ADMIN + '/', 800); await cdp.wait(1000); await tab('Сайт');
  check('админка: после перезагрузки значение сохранено (данные не потеряны)', await cdp.eval(`[...document.querySelectorAll('#editor .field textarea')].some(x => x.value === ${JSON.stringify(MARK)})`));

  // --- 2. Загрузка изображения → бот → публикация → картинка на сайте ---
  const png = execFileSync('python3', ['-c', `
import io,sys
from PIL import Image
b=io.BytesIO(); Image.new('RGB',(120,80),(30,140,90)).save(b,'PNG'); sys.stdout.buffer.write(b.getvalue())`]);
  const up = await (await fetch(ADMIN + '/api/upload?name=e2e-bot.png', { method: 'POST', headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'image/png' }, body: png })).json();
  check('загрузка: изображение принято и лежит в public/previews временной копии', up.ok && fs.existsSync(path.join(tmp, 'public', up.path)), up.path);
  let data = (await api('/api/data')).body;
  const projects = JSON.parse(JSON.stringify(data.data.projects)); projects.bots[0].screenPreview = up.path;
  let r = await api('/api/save', { method: 'POST', body: JSON.stringify({ file: 'projects', data: projects, ifMatch: data.etags.projects }) });
  check('проекты: путь загруженного изображения сохраняется в данных бота', r.status === 200, String(r.status));
  await fresh();
  const n2 = await publish();
  const h2 = await html();
  check('публикация №2 прошла; сайт: картинка бота из админки в каталоге ботов', /Проект проверен и собран|Релиз/.test(n2) && h2.includes(`src="${up.path}"`));
  check('сайт: файл загруженной картинки отдаётся (200) из собранной копии', (await fetch(SITE + up.path)).status === 200 && fs.existsSync(path.join(tmp, 'dist', up.path)));

  // --- 3. Управление проектами через интерфейс: архив → публикация → восстановление ---
  await fresh(); await tab('Лендинги');
  const victim = JSON.parse(fs.readFileSync(path.join(tmp, 'src/data/projects.json'), 'utf8')).landings[3];
  await cdp.eval(`[...document.querySelectorAll('.landing-row')].find(r => r.querySelector('.landing-name').textContent === ${JSON.stringify(victim.name)}).querySelectorAll('button').forEach(b => { if (b.textContent === 'В архив') b.click(); })`); await cdp.wait(400);
  await save();
  const nA = await publish();
  const hA = await html();
  const drawer = victim.drawerId || ('modal-landing-' + victim.id);
  check('архив лендинга через админку: после публикации его нет на сайте (панель и чип), остальные на месте', /Проект проверен и собран|Релиз/.test(nA) && !hA.includes(`id="${drawer}"`) && (hA.match(/id="modal-landing-/g) || []).length === 4, `панелей лендингов: ${(hA.match(/id="modal-landing-/g) || []).length}`);
  await fresh(); await tab('Лендинги');
  await cdp.eval(`(() => { const s = document.querySelector('.pv-status'); s.value = 'archived'; s.dispatchEvent(new Event('change')); })()`); await cdp.wait(400);
  await cdp.eval(`[...document.querySelectorAll('.landing-row')].find(r => r.querySelector('.landing-name').textContent === ${JSON.stringify(victim.name)}).querySelectorAll('button').forEach(b => { if (b.textContent === 'Восстановить') b.click(); })`); await cdp.wait(400);
  await save();
  const nR = await publish();
  const hR = await html();
  check('восстановление через админку: лендинг снова на сайте', /Проект проверен и собран|Релиз/.test(nR) && hR.includes(`id="${drawer}"`) && (hR.match(/id="modal-landing-/g) || []).length === 5);

  // --- 4. Импорт → публикация ---
  const bundle = (await (await fetch(ADMIN + '/api/export', { headers: { 'X-Admin-Token': TOKEN } })).json());
  bundle.files.site.topbar.vibe = 'IMPORT VIBE ' + crypto.randomBytes(2).toString('hex'); delete bundle.checksums.site;
  r = await api('/api/import?dryRun=0', { method: 'POST', body: JSON.stringify({ bundle }) });
  const nI = (await fresh(), await publish());
  check('импорт данных → публикация: импортированное значение на сайте', r.status === 200 && /Проект проверен|Релиз/.test(nI) && (await html()).includes(bundle.files.site.topbar.vibe), r.status + '');

  // --- 5. Безопасность публикации ---
  const noTok = await fetch(ADMIN + '/api/publish', { method: 'POST' });
  check('публикация без токена → 401', noTok.status === 401);
  const bad = JSON.parse(JSON.stringify((await api('/api/data')).body.data.links)); bad.socials[0].url = 'javascript:alert(1)';
  check('опасные данные в обход интерфейса не проходят сохранение (422)', (await api('/api/save', { method: 'POST', body: JSON.stringify({ file: 'links', data: bad, ifMatch: (await api('/api/data')).body.etags.links }) })).status === 422);
  check('токен не попал в журнал сервера', !srvLog.includes(TOKEN));
  check('в консоли админки нет JS-ошибок', cdp.jsErrors().length === 0, cdp.jsErrors().join('; '));
  await cdp.shot('/tmp/gonka-admin-e2e.png');

  check('реальные данные проекта и реальный dist не изменялись тестом', JSON.stringify(['src/data/site.json', 'src/data/projects.json', 'src/data/media.json'].map(realHash)) === JSON.stringify(realBefore) && fs.statSync(path.join(ROOT, 'dist/index.html')).mtimeMs === realDistBefore);
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { site?.kill(); } catch { /* ignore */ }
  srv.kill();
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 1500);
}
console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
