#!/usr/bin/env node
// tools/admin/test-media-io.mjs — загрузка изображений, экспорт/импорт, версия сервера, безопасность этих функций; API и интерфейс (CDP).
// Работает на ВРЕМЕННЫХ копиях (данные, каталог public, журнал). Реальные src/data и public/ не изменяются.
// Для генерации тестовых изображений используется python3 + Pillow (как в tools/scene).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gonka-media-'));
const dataDir = path.join(tmp, 'data'), pubDir = path.join(tmp, 'public'), fx = path.join(tmp, 'fx');
fs.mkdirSync(dataDir); fs.mkdirSync(path.join(pubDir, 'previews'), { recursive: true }); fs.mkdirSync(fx);
for (const f of fs.readdirSync(path.join(ROOT, 'src', 'data')).filter((x) => x.endsWith('.json'))) fs.copyFileSync(path.join(ROOT, 'src', 'data', f), path.join(dataDir, f));
for (const f of fs.readdirSync(path.join(ROOT, 'public', 'previews'))) fs.copyFileSync(path.join(ROOT, 'public', 'previews', f), path.join(pubDir, 'previews', f));
const realBefore = ['src/data/media.json', 'src/data/site.json', 'src/data/projects.json'].map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'));
const realPreviewsBefore = fs.readdirSync(path.join(ROOT, 'public', 'previews')).length;

// --- тестовые изображения ---
execFileSync('python3', ['-c', `
from PIL import Image
import struct, zlib
fx='${fx}'
im=Image.new('RGB',(64,48),(200,120,40)); im.save(fx+'/ok.png')
im.save(fx+'/ok.jpg',quality=85); im.save(fx+'/ok.webp',quality=80)
# JPEG и WebP с EXIF (в т.ч. GPS)
ex=Image.Exif(); ex[0x010F]='TestCamera'; ex[0x0110]='SecretModel'
gps=ex.get_ifd(0x8825); gps[1]='N'; gps[2]=(45.0,15.0,0.0); gps[3]='E'; gps[4]=(19.0,51.0,0.0)
im.save(fx+'/exif.jpg',quality=85,exif=ex.tobytes()); im.save(fx+'/exif.webp',quality=80,exif=ex.tobytes())
# слишком маленькое и «огромное по заголовку» PNG
Image.new('RGB',(8,8),(1,2,3)).save(fx+'/tiny.png')
def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
sig=b'\\x89PNG\\r\\n\\x1a\\n'
huge=sig+chunk(b'IHDR',struct.pack('>IIBBBBB',20000,20000,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\\x00\\x00\\x00\\x00'))+chunk(b'IEND',b'')
open(fx+'/huge.png','wb').write(huge)
`], { stdio: 'inherit' });
const F = (n) => fs.readFileSync(path.join(fx, n));
const okPng = F('ok.png');

const TOKEN = 'test-token-0123456789abcdef-mediaio';
const env = { ...process.env, ADMIN_DATA_DIR: dataDir, ADMIN_PUBLIC_DIR: pubDir, ADMIN_AUDIT_FILE: path.join(tmp, 'audit.log'), ADMIN_TOKEN: TOKEN, ADMIN_PORT: '4340' };
const srv = spawn(process.execPath, [path.join(ROOT, 'tools/admin/server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let srvLog = ''; srv.stdout.on('data', (d) => { srvLog += d; }); srv.stderr.on('data', (d) => { srvLog += d; });
await new Promise((r) => setTimeout(r, 1500));

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const BASE = 'http://127.0.0.1:4340';
const H = { 'X-Admin-Token': TOKEN };
const raw = async (url, opt = {}) => { const r = await fetch(BASE + url, opt); const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* не JSON */ } return { status: r.status, buf, json, headers: r.headers }; };
const upload = (buf, type = 'image/png', name = 'photo.png', token = TOKEN) => raw('/api/upload?name=' + encodeURIComponent(name), { method: 'POST', headers: { ...(token ? { 'X-Admin-Token': token } : {}), 'Content-Type': type }, body: buf });
const previewsList = () => fs.readdirSync(path.join(pubDir, 'previews'));
const parentBefore = fs.readdirSync(tmp).sort().join();
let cdp = null, fake = null;
try {
  // ===== версия сервера =====
  let r = await raw('/api/health');
  check('health: без авторизации отдаёт версию API и ничего лишнего', r.status === 200 && r.json.apiVersion >= 4 && Object.keys(r.json).sort().join() === 'apiVersion,ok,startedAt', JSON.stringify(Object.keys(r.json)));

  // ===== загрузка =====
  r = await upload(okPng, 'image/png', 'photo.png', null);
  check('загрузка без токена → 401', r.status === 401);
  r = await upload(okPng, 'image/png', 'photo.png', 'wrong-token-wrong-token');
  check('загрузка с неверным токеном → 401', r.status === 401);
  for (const [file, type, ext] of [['ok.png', 'image/png', 'png'], ['ok.jpg', 'image/jpeg', 'jpg'], ['ok.webp', 'image/webp', 'webp']]) {
    r = await upload(F(file), type, 'Мой снимок ' + file);
    const stored = r.json?.name && path.join(pubDir, 'previews', r.json.name);
    check(`загрузка ${ext.toUpperCase()}: 200, путь /previews/<слаг>-<hex>.${ext}, файл создан, размеры ${r.json?.width}×${r.json?.height}`, r.status === 200 && new RegExp(`^/previews/[a-z0-9-]+-[0-9a-f]{8}\\.${ext}$`).test(r.json.path) && fs.existsSync(stored) && r.json.width === 64 && r.json.height === 48, r.json?.path || JSON.stringify(r.json));
    if (r.status === 200) {
      const served = await raw(r.json.path);
      check(`  ${ext.toUpperCase()}: админка отдаёт файл как image/${ext === 'jpg' ? 'jpeg' : ext} (для миниатюр)`, served.status === 200 && served.headers.get('content-type') === `image/${ext === 'jpg' ? 'jpeg' : ext}` && served.buf.equals(fs.readFileSync(stored)));
    }
  }
  const lst = await raw('/api/media', { headers: H });
  check('список /api/media: содержит загруженные, без служебных файлов', lst.status === 200 && lst.json.files.length >= 3 && lst.json.files.every((f) => /^[a-z0-9][a-z0-9._-]*\.(png|jpg|webp)$/.test(f.name)));
  const dupA = (await upload(okPng, 'image/png', 'same.png')).json.name, dupB = (await upload(okPng, 'image/png', 'same.png')).json.name;
  check('одинаковые имена не перезаписывают друг друга', dupA !== dupB && fs.existsSync(path.join(pubDir, 'previews', dupA)) && fs.existsSync(path.join(pubDir, 'previews', dupB)));

  // метаданные
  r = await upload(F('exif.jpg'), 'image/jpeg', 'gps.jpg');
  let saved = fs.readFileSync(path.join(pubDir, 'previews', r.json.name));
  check('JPEG с EXIF/GPS: загружен, метаданные удалены (нет Exif, TestCamera, SecretModel)', r.status === 200 && r.json.cleaned === true && !saved.includes('Exif') && !saved.includes('TestCamera') && !saved.includes('SecretModel') && saved.length < F('exif.jpg').length, `${F('exif.jpg').length} → ${saved.length} байт`);
  check('  очищенный JPEG остаётся валидным изображением', execFileSync('python3', ['-c', `from PIL import Image; im=Image.open('${path.join(pubDir, 'previews', r.json.name)}'); im.load(); print(im.size)`]).toString().trim() === '(64, 48)');
  r = await upload(F('exif.webp'), 'image/webp', 'gps.webp');
  saved = fs.readFileSync(path.join(pubDir, 'previews', r.json.name));
  check('WebP с EXIF: метаданные удалены, файл валиден', r.status === 200 && !saved.includes('EXIF') && !saved.includes('TestCamera') && execFileSync('python3', ['-c', `from PIL import Image; im=Image.open('${path.join(pubDir, 'previews', r.json.name)}'); im.load(); print(im.size)`]).toString().trim() === '(64, 48)', `${F('exif.webp').length} → ${saved.length}`);
  r = await upload(Buffer.concat([okPng, Buffer.from('<html><script>alert(1)</script></html>')]), 'image/png', 'poly.png');
  saved = fs.readFileSync(path.join(pubDir, 'previews', r.json.name));
  check('PNG с дописанным HTML-хвостом: хвост отброшен (полиглот невозможен)', r.status === 200 && !saved.includes('<script') && saved.equals(okPng));

  // отказы
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
  const rejects = [
    ['SVG под видом PNG', svg, 'image/png', 'x.png'], ['SVG с типом image/svg+xml', svg, 'image/svg+xml', 'x.svg'], ['HTML под видом JPEG', Buffer.from('<html><body>hi</body></html>'), 'image/jpeg', 'x.jpg'],
    ['текст .png', Buffer.from('просто текст, не картинка'), 'image/png', 'x.png'], ['обрезанный PNG', okPng.subarray(0, 60), 'image/png', 'x.png'],
    ['JPEG, заявленный как PNG', F('ok.jpg'), 'image/png', 'x.png'], ['GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;', 'latin1'), 'image/gif', 'x.gif'],
    ['слишком маленькое (8×8)', F('tiny.png'), 'image/png', 'tiny.png'], ['огромное по заголовку (20000×20000)', F('huge.png'), 'image/png', 'huge.png'],
    ['пустой файл', Buffer.alloc(0), 'image/png', 'e.png'], ['больше 2 МБ (в пределах допуска)', Buffer.concat([okPng, Buffer.alloc(2 * 1024 * 1024 + 10)]), 'image/png', 'big.png'],
  ];
  const before = previewsList().length;
  for (const [name, body, type, fname] of rejects) {
    r = await upload(body, type, fname);
    check(`отказ: ${name} → 4xx, файл не создан`, r.status >= 400 && r.status < 500, `${r.status} ${r.json?.error || ''}`.slice(0, 120));
  }
  r = await upload(Buffer.alloc(2 * 1024 * 1024 + 5000, 1), 'image/png', 'huge.png');
  check('отказ: тело сильно больше 2 МБ → 413', r.status === 413, String(r.status));
  check('после всех отказов в каталоге превью не появилось новых файлов', previewsList().length === before, `${before} → ${previewsList().length}`);
  check('нет временных файлов .upload-*.tmp после загрузок', !previewsList().some((f) => f.endsWith('.tmp')));

  // имя файла и путь
  const names = ['../../etc/passwd.png', '..%2F..%2Fescape.png', 'C:\\Windows\\evil.png', '<script>.png', 'a'.repeat(300) + '.png', ''];
  let escaped = false;
  for (const n of names) {
    const rr = await upload(okPng, 'image/png', n);
    if (rr.status !== 200 || !/^\/previews\/[a-z0-9-]+-[0-9a-f]{8}\.png$/.test(rr.json.path) || rr.json.name.length > 60) escaped = true;
  }
  check('опасные имена (../, \\, <script>, 300 символов, пустое) → безопасное имя, всё внутри public/previews', !escaped && fs.readdirSync(tmp).filter((f) => f !== 'audit.log').sort().join() === parentBefore && !fs.existsSync(path.join(tmp, 'escape.png')) && !fs.existsSync(path.join(pubDir, 'escape.png')));
  const trav = await raw('/previews/..%2f..%2fdata%2fsite.json');
  check('раздача превью: обход каталога невозможен', trav.status === 404 || trav.status === 400);
  const evilExt = await raw('/previews/readme.svg');
  check('раздача превью: SVG и прочие расширения не отдаются', evilExt.status === 404);

  // привязка к данным: путь в media.json принимается только к существующему PNG/JPG/WebP
  const dataNow = (await raw('/api/data', { headers: H })).json;
  const media = JSON.parse(JSON.stringify(dataNow.data.media));
  const up = (await upload(okPng, 'image/png', 'use.png')).json;
  media.previews.authorPortrait = up.path;
  r = await raw('/api/save', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'media', data: media, ifMatch: dataNow.etags.media }) });
  check('media.json: загруженный путь сохраняется (200)', r.status === 200, String(r.status));
  const m2 = JSON.parse(JSON.stringify(media)); m2.previews.authorPortrait = '/previews/evil.svg';
  r = await raw('/api/save', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'media', data: m2, ifMatch: r.json?.etag }) });
  check('media.json: путь на SVG отклоняется (422)', r.status === 422, String(r.status));

  // ===== экспорт =====
  r = await raw('/api/export');
  check('экспорт без токена → 401', r.status === 401);
  r = await raw('/api/export', { headers: H });
  const bundle = r.json;
  const etags = (await raw('/api/data', { headers: H })).json.etags;
  check('экспорт: пакет gonka-blog-content v1, 6 файлов, контрольные суммы = текущим', r.status === 200 && bundle.format === 'gonka-blog-content' && Object.keys(bundle.files).length === 6 && Object.keys(bundle.files).every((n) => bundle.checksums[n] === etags[n]));
  check('экспорт: скачивание (Content-Disposition attachment, имя с датой), токена в файле нет', /attachment; filename="gonka-blog-content-\d{8}-\d{6}\.json"/.test(r.headers.get('content-disposition') || '') && !r.buf.toString('utf8').includes(TOKEN));

  // ===== импорт =====
  const imp = (b, dry, ctype = 'application/json', body = null) => raw('/api/import?dryRun=' + (dry ? 1 : 0), { method: 'POST', headers: { ...H, 'Content-Type': ctype }, body: body ?? JSON.stringify({ bundle: b }) });
  r = await raw('/api/import?dryRun=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundle }) });
  check('импорт без токена → 401', r.status === 401);
  r = await imp(bundle, true);
  check('импорт собственного экспорта (dryRun): ок, изменений нет', r.status === 200 && r.json.changed.length === 0);
  const mod = JSON.parse(JSON.stringify(bundle)); mod.files.site.topbar.vibe = 'ИМПОРТ ТЕСТ'; mod.checksums.site = crypto.createHash('sha256').update(JSON.stringify(mod.files.site, null, 2) + '\n').digest('hex');
  r = await imp(mod, true);
  const afterDry = (await raw('/api/data', { headers: H })).json.data.site.topbar.vibe;
  check('dryRun: показывает изменение (site), но ничего не записывает', r.status === 200 && r.json.dryRun === true && eq(r.json.changed, ['site']) && afterDry !== 'ИМПОРТ ТЕСТ', afterDry);
  const bakBefore = fs.readdirSync(path.join(dataDir, '.backups')).length;
  r = await imp(mod, false);
  const afterImp = (await raw('/api/data', { headers: H })).json.data.site.topbar.vibe;
  check('импорт: данные записаны, резервная копия создана перед записью', r.status === 200 && eq(r.json.changed, ['site']) && afterImp === 'ИМПОРТ ТЕСТ' && fs.readdirSync(path.join(dataDir, '.backups')).length === bakBefore + 1 && !!r.json.backups?.[0]?.backup, JSON.stringify(r.json.backups));
  r = await imp(mod, false);
  check('повторный импорт того же пакета: изменений нет', r.status === 200 && r.json.changed.length === 0);
  const rt = (await raw('/api/export', { headers: H })).json;
  check('круговой тест: экспорт после импорта содержит импортированное значение и совпадающие суммы', rt.files.site.topbar.vibe === 'ИМПОРТ ТЕСТ' && rt.checksums.site === mod.checksums.site);

  const bad = (label, mutate, status = 422) => async () => { const b = JSON.parse(JSON.stringify(bundle)); const x = mutate(b); const rr = x ?? await imp(b, false); check(`импорт отклонён: ${label} (${status}), данные не изменены`, rr.status === status, `${rr.status} ${JSON.stringify(rr.json?.errors?.[0] || rr.json?.error || '').slice(0, 110)}`); };
  const snapshot = JSON.stringify((await raw('/api/data', { headers: H })).json.data);
  await bad('не пакет GONKA.BLOG', (b) => { b.format = 'other'; })();
  await bad('удалён обязательный ключ (site.meta)', (b) => { delete b.files.site.meta; delete b.checksums.site; })();
  await bad('неизвестное поле схемы', (b) => { b.files.links.socials[0].hack = 'x'; delete b.checksums.links; })();
  await bad('опасная ссылка javascript:', (b) => { b.files.links.socials[0].url = 'javascript:alert(1)'; delete b.checksums.links; })();
  await bad('контрольная сумма не совпадает (пакет изменён вручную)', (b) => { b.files.site.topbar.status = 'подмена'; })();
  await bad('неизвестный файл данных', (b) => { b.files['../../etc/passwd'] = { a: 1 }; })();
  await bad('ключ __proto__ в files', (b) => { b.files = JSON.parse('{"__proto__":{"polluted":true}}'); })();
  await bad('предмет сцены ведёт на несуществующую панель', (b) => { b.files.scene.items[0].target = 'modal-nope'; delete b.checksums.scene; })();
  await bad('медиа: путь на SVG', (b) => { b.files.media.previews.authorPortrait = '/previews/x.svg'; delete b.checksums.media; })();
  await bad('медиа: файла нет в public/previews', (b) => { b.files.media.previews.authorPortrait = '/previews/net-takogo-12345678.png'; delete b.checksums.media; })();
  await bad('проект исчезает без архивации', (b) => { b.files.projects.bots.splice(0, 1); delete b.checksums.projects; })();
  await bad('повторяющийся id проекта', (b) => { b.files.projects.bots[1].id = b.files.projects.bots[0].id; delete b.checksums.projects; })();
  await bad('неверный Content-Type', () => imp(null, false, 'text/plain', 'x'), 415);
  await bad('не JSON', () => imp(null, false, 'application/json', '{oops'), 400);
  await bad('пакет больше 8 МБ', () => imp(null, false, 'application/json', '{"bundle":"' + 'x'.repeat(9 * 1024 * 1024) + '"}'), 413);
  check('после отклонённых импортов данные не изменились', JSON.stringify((await raw('/api/data', { headers: H })).json.data) === snapshot);
  const proto = ({}).polluted; check('Object.prototype не загрязнён', proto === undefined);

  // токен не попадает в логи и ответы об ошибках
  check('токен не встречается в журнале сервера, audit.log и в ответах-ошибках', !srvLog.includes(TOKEN) && !fs.readFileSync(path.join(tmp, 'audit.log'), 'utf8').includes(TOKEN) && !JSON.stringify((await upload(okPng, 'image/png', 'a.png', 'bad-token-bad-token')).json).includes(TOKEN));
  check('audit.log: записаны upload и import без содержимого файлов', /"action":"upload"/.test(fs.readFileSync(path.join(tmp, 'audit.log'), 'utf8')) && /"action":"import"/.test(fs.readFileSync(path.join(tmp, 'audit.log'), 'utf8')));

  // ===== интерфейс (CDP) =====
  const { launch } = await import('../scene/cdp.mjs');
  // 1) устаревший сервер: интерфейс не должен писать «токен не принят»
  const uiFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'], '/ui/app.js': ['app.js', 'application/javascript; charset=utf-8'], '/ui/style.css': ['style.css', 'text/css; charset=utf-8'], '/ui/project-ops.mjs': ['../lib/project-ops.mjs', 'application/javascript; charset=utf-8'] };
  fake = http.createServer((req, res) => { const u = new URL(req.url, 'http://x').pathname; const f = uiFiles[u]; if (f) { res.writeHead(200, { 'Content-Type': f[1] }); res.end(fs.readFileSync(path.join(ROOT, 'tools/admin/ui', f[0]))); } else if (u === '/api/data') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"нет токена"}'); } else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); } }).listen(4342, '127.0.0.1');
  cdp = await launch({ width: 1300, height: 900, port: 9961 });
  await cdp.goto('http://127.0.0.1:4342/', 500);
  await cdp.eval(`sessionStorage.setItem('gonka-admin-token', 'whatever-token-value-123')`);
  await cdp.goto('http://127.0.0.1:4342/', 1500);
  const gateText = await cdp.eval(`document.getElementById('gate-error')?.textContent || ''`);
  check('интерфейс: при устаревшем сервере показывает понятное сообщение про перезапуск, а не «токен не принят»', /устаревшей версии/.test(gateText) && /npm run admin/.test(gateText) && !/Токен не принят/.test(gateText), gateText.slice(0, 90));
  fake.close();

  // 2) обычная работа
  await cdp.goto(BASE + '/', 500);
  await cdp.eval(`sessionStorage.setItem('gonka-admin-token', ${JSON.stringify(TOKEN)})`);
  await cdp.goto(BASE + '/', 1500);
  check('интерфейс: вход по токену выполнен, вкладки видны', !!(await cdp.eval(`document.querySelectorAll('#tabs button').length`)) && (await cdp.eval(`document.getElementById('app').hidden`)) === false);
  await cdp.eval(`[...document.querySelectorAll('#tabs button')].find(x => x.textContent === 'Медиа').click()`); await cdp.wait(700);
  check('интерфейс: вкладка «Медиа» показывает загрузку и галерею с миниатюрами', await cdp.eval(`!!document.querySelector('.media-tools input[type=file]') && document.querySelectorAll('.media-gallery .media-item').length > 3`));
  const imgsOk = await cdp.eval(`new Promise(r => setTimeout(() => r([...document.querySelectorAll('.media-gallery img')].every(i => i.complete && i.naturalWidth > 0)), 1500))`);
  check('интерфейс: миниатюры действительно загружаются (раздача превью админкой)', imgsOk === true);
  const doc = await cdp.send('DOM.getDocument', {});
  const inp = await cdp.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '.media-tools input[type=file]' });
  await cdp.send('DOM.setFileInputFiles', { files: [path.join(fx, 'ok.jpg')], nodeId: inp.result.nodeId });
  await cdp.wait(1200);
  const uploadMsg = await cdp.eval(`document.querySelector('.upload-result')?.textContent || ''`);
  check('интерфейс: загрузка через форму — сообщение «Загружено: /previews/…»', /^Загружено: \/previews\/[a-z0-9-]+-[0-9a-f]{8}\.jpg \(64×48/.test(uploadMsg), uploadMsg.slice(0, 100));
  await cdp.send('DOM.setFileInputFiles', { files: [path.join(fx, 'tiny.png')], nodeId: inp.result.nodeId }); await cdp.wait(800);
  check('интерфейс: слишком маленькое изображение — понятная ошибка', /Не загружено: .*слишком маленькое/.test(await cdp.eval(`document.querySelector('.upload-result')?.textContent || ''`)));
  fs.writeFileSync(path.join(fx, 'file.svg'), svg);
  await cdp.send('DOM.setFileInputFiles', { files: [path.join(fx, 'file.svg')], nodeId: inp.result.nodeId }); await cdp.wait(500);
  check('интерфейс: SVG отклоняется ещё до отправки', /Не загружено: .*SVG запрещён/.test(await cdp.eval(`document.querySelector('.upload-result')?.textContent || ''`)));
  await cdp.shot('/tmp/gonka-admin-media.png');

  // экспорт и импорт через интерфейс
  const dl = path.join(tmp, 'dl'); fs.mkdirSync(dl);
  await cdp.browserSend('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  await cdp.eval(`document.getElementById('btn-export').click()`); await cdp.wait(1500);
  const dlFiles = fs.readdirSync(dl).filter((f) => f.endsWith('.json'));
  const exported = dlFiles.length ? JSON.parse(fs.readFileSync(path.join(dl, dlFiles[0]), 'utf8')) : null;
  check('интерфейс: «Экспорт» скачивает файл-пакет с данными', !!exported && exported.format === 'gonka-blog-content' && Object.keys(exported.files).length === 6, dlFiles.join());
  exported.files.site.topbar.status = 'СТАТУС ИЗ ИМПОРТА'; delete exported.checksums.site;
  const impFile = path.join(fx, 'import.json'); fs.writeFileSync(impFile, JSON.stringify(exported));
  await cdp.eval(`window.confirm = (m) => { window.__confirmMsg = m; return true; }`);
  const doc2 = await cdp.send('DOM.getDocument', {});
  const imp2 = await cdp.send('DOM.querySelector', { nodeId: doc2.result.root.nodeId, selector: '#import-file' });
  await cdp.send('DOM.setFileInputFiles', { files: [impFile], nodeId: imp2.result.nodeId }); await cdp.wait(1800);
  const cm = await cdp.eval(`window.__confirmMsg || ''`);
  check('интерфейс: импорт сначала показывает, что изменится, и просит подтверждение (резервная копия)', /Импорт заменит данные: site/.test(cm) && /резервная копия/.test(cm), cm.slice(0, 80));
  const siteAfter = (await raw('/api/data', { headers: H })).json.data.site.topbar.status;
  check('интерфейс: после подтверждения данные импортированы и видны в админке', siteAfter === 'СТАТУС ИЗ ИМПОРТА', siteAfter);
  await cdp.eval(`window.confirm = () => true`);
  fs.writeFileSync(impFile, '{"format":"oops"}');
  await cdp.send('DOM.setFileInputFiles', { files: [impFile], nodeId: imp2.result.nodeId }); await cdp.wait(1200);
  check('интерфейс: чужой JSON отклоняется с сообщением, данные не тронуты', /отклонён/.test(await cdp.eval(`document.getElementById('notices').textContent`)) && (await raw('/api/data', { headers: H })).json.data.site.topbar.status === 'СТАТУС ИЗ ИМПОРТА');

  // кнопка загрузки в редакторе бота
  await cdp.eval(`[...document.querySelectorAll('#tabs button')].find(x => x.textContent === 'Боты').click()`); await cdp.wait(500);
  await cdp.eval(`[...document.querySelectorAll('.bots-view .landing-row')][0].querySelector('button').click()`); await cdp.wait(500);
  const hasBtn = await cdp.eval(`!!document.querySelector('#bot-fields [data-k="screenPreview"]').parentElement.querySelector('.upload-btn')`);
  check('интерфейс: в редакторе бота есть кнопка «Загрузить файл…» у поля превью', hasBtn === true);
  check('интерфейс: нет JS-ошибок', cdp.jsErrors().length === 0, cdp.jsErrors().join('; '));

  // ===== ограничение попыток (в конце: блокирует IP на минуту) =====
  let last = 0; for (let i = 0; i < 7; i++) last = (await upload(okPng, 'image/png', 'a.png', 'x' + i + 'wrong-token-wrong')).status;
  check('перебор токена: после 5 неверных попыток доступ блокируется (429)', last === 429, String(last));
  check('реальные файлы проекта не изменялись тестом (data и public/previews)', JSON.stringify(['src/data/media.json', 'src/data/site.json', 'src/data/projects.json'].map((f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex'))) === JSON.stringify(realBefore) && fs.readdirSync(path.join(ROOT, 'public', 'previews')).length === realPreviewsBefore);
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  try { fake?.close(); } catch { /* ignore */ }
  srv.kill();
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 1500);
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
