#!/usr/bin/env node
// tools/admin/server.mjs — локальный сервер админки GONKA.BLOG.
// Только 127.0.0.1, Bearer-токен (файл .token, 0600), валидация схемами,
// allowlist ссылок, атомарная запись, лок, бэкап перед сохранением, audit.log.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

import {
  ROOT, FILE_NAMES, readAll, allEtags, etagOf, serialize, paths,
  withLock, atomicWriteJSON, createBackup, listBackups, readBackupJSON,
  appendAudit, cleanupTmp, ensureDirs, LockBusyError, EtagMismatchError, NotFoundError,
} from './store.mjs';
import { validateFile, normalizeSiteData } from './validate.mjs';
import { checkBindings } from './bindings.mjs';
import { findUnarchivedRemovals, slugify } from './lib/project-ops.mjs';
import { inspectImage, MIME_EXT, MAX_BYTES } from './lib/image-check.mjs';
import {
  releaseMode, config as releaseConfig, newReleaseName, releasePath, listReleases,
  activate, prune, rollback, commitContent, clientIp,
} from './release.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ADMIN_PORT || 4310);
const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024; // 1 МБ
const MAX_IMPORT = 8 * 1024 * 1024; // пакет импорта: до 8 МБ
export const API_VERSION = 4; // 4: загрузка изображений, экспорт/импорт, /api/health
const STARTED_AT = new Date().toISOString();
const MAX_UPLOADS = 300;
// Публичный адрес за nginx (например https://admin.gonka.blog). Слушаем по-прежнему только 127.0.0.1.
let PUBLIC_ORIGIN = null;
if (process.env.ADMIN_PUBLIC_ORIGIN) {
  const u = new URL(process.env.ADMIN_PUBLIC_ORIGIN);
  if (u.protocol !== 'https:') throw new Error('ADMIN_PUBLIC_ORIGIN должен быть https://');
  PUBLIC_ORIGIN = u.origin;
}
let publishing = false; // защита от параллельных публикаций

// --- токен: из ADMIN_TOKEN (тесты) или из файла .token (генерация при первом запуске) ---
function loadToken() {
  if (process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length >= 16) {
    return process.env.ADMIN_TOKEN;
  }
  const p = path.join(HERE, '.token');
  if (!fs.existsSync(p)) {
    const t = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(p, t, { mode: 0o600 });
  }
  return fs.readFileSync(p, 'utf8').trim();
}
const TOKEN = loadToken();
const TOKEN_SHA = crypto.createHash('sha256').update(TOKEN).digest();

function tokenMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const given = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(given, TOKEN_SHA);
}

// --- rate limit неудачных попыток ---
const attempts = new Map(); // ip -> {fails, blockedUntil}
function rateLimited(ip) {
  const a = attempts.get(ip);
  return a && a.blockedUntil > Date.now();
}
function registerFail(ip) {
  const a = attempts.get(ip) || { fails: 0, blockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= 5) {
    a.blockedUntil = Date.now() + 60_000;
    a.fails = 0;
  }
  attempts.set(ip, a);
}
function resetFails(ip) {
  attempts.delete(ip);
}

function send(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(body);
}

function sendFile(res, absPath, type) {
  const buf = fs.readFileSync(absPath);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(buf);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // не храним данные, но дочитываем запрос, чтобы клиент получил ответ 413,
        // а не обрыв соединения; жёсткий предохранитель — 8 лимитов
        tooLarge = true;
        chunks.length = 0;
        if (size > 8 * limit) {
          reject(Object.assign(new Error('body too large'), { code: 'toolarge' }));
          req.destroy();
        }
        return;
      }
      if (!tooLarge) chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(Object.assign(new Error('body too large'), { code: 'toolarge' }));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function authOk(req) {
  // X-Admin-Token — основной (за nginx auth_basic заголовок Authorization занят Basic-логином)
  const x = req.headers['x-admin-token'];
  if (typeof x === 'string' && x) return tokenMatches(x.trim());
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return false;
  return tokenMatches(h.slice(7).trim());
}

function hostOk(req) {
  const host = (req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
  if (host === '127.0.0.1' || host === 'localhost') return true;
  return PUBLIC_ORIGIN !== null && host === new URL(PUBLIC_ORIGIN).hostname;
}

function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
    if (PUBLIC_ORIGIN !== null && u.origin === PUBLIC_ORIGIN) return true;
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(PORT);
  } catch {
    return false;
  }
}

function validateWithBindings(file, data) {
  const result = validateFile(file, data);
  if (result.errors.length) return result;
  const all = readAll();
  all[file] = data;
  const b = checkBindings({ data: all });
  return {
    errors: [...result.errors, ...b.errors],
    warnings: [...result.warnings, ...b.warnings],
  };
}

async function handleApi(req, res, url) {
  const ip = clientIp(req);

  if (!hostOk(req) || !originOk(req)) {
    return send(res, 403, { error: 'запрос не с localhost' });
  }

  if (req.method === 'GET' && url.pathname === '/api/data') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    try {
      return send(res, 200, { data: readAll(), etags: allEtags(), files: FILE_NAMES });
    } catch (e) {
      return send(res, 500, { error: 'данные не читаются: ' + e.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/backups') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    return send(res, 200, { backups: listBackups() });
  }

  if (req.method === 'POST' && (url.pathname === '/api/save' || url.pathname === '/api/restore')) {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);

    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) return send(res, 415, { error: 'ожидается application/json' });

    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw.toString('utf8'));
    } catch (e) {
      if (e.code === 'toolarge') return send(res, 413, { error: 'тело запроса больше 1 МБ' });
      return send(res, 400, { error: 'некорректный JSON в запросе' });
    }

    try {
      if (url.pathname === '/api/save') {
        const { file, data, ifMatch } = body || {};
        if (!FILE_NAMES.includes(file)) return send(res, 404, { error: 'неизвестный файл' });
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return send(res, 400, { error: 'data должен быть объектом' });
        }
        if (file === 'site') {
          normalizeSiteData(data);
        }
        const v = validateWithBindings(file, data);
        if (v.errors.length) return send(res, 422, { errors: v.errors, warnings: v.warnings });

        // Защита от случайной потери: проект можно убрать из projects.json только из архива
        if (file === 'projects') {
          const lost = findUnarchivedRemovals(readAll().projects, data);
          if (lost.length) {
            return send(res, 422, { errors: lost.map((x) => ({ path: `${x.group}.${x.id}`, message: `проект «${x.name || x.id}» удалён без архивации — сначала переведите его в архив` })), warnings: v.warnings });
          }
        }

        const outcome = withLock(() => {
          const current = etagOf(file);
          if (ifMatch !== current) throw new EtagMismatchError();
          const backup = createBackup(file);
          const { fromSha, toSha } = atomicWriteJSON(file, data);
          appendAudit('save', file, fromSha, toSha);
          return { etag: toSha, backup };
        });
        return send(res, 200, { ok: true, etag: outcome.etag, backup: outcome.backup, warnings: v.warnings });
      }

      // /api/restore
      const { name, ifMatch } = body || {};
      if (typeof name !== 'string') return send(res, 400, { error: 'нет name' });
      const file = name.split('.')[0];
      if (!FILE_NAMES.includes(file)) return send(res, 404, { error: 'неизвестный файл' });
      let restored;
      try {
        restored = readBackupJSON(name);
      } catch (e) {
        if (e instanceof NotFoundError) return send(res, 404, { error: 'бэкап не найден' });
        return send(res, 422, { errors: [{ path: name, message: e.message }] });
      }
      const v = validateWithBindings(file, restored);
      if (v.errors.length) {
        return send(res, 422, { errors: v.errors, warnings: v.warnings, note: 'бэкап не проходит валидацию' });
      }
      const outcome = withLock(() => {
        const current = etagOf(file);
        if (ifMatch && ifMatch !== current) throw new EtagMismatchError();
        createBackup(file); // откат текущего состояния перед восстановлением
        const { fromSha, toSha } = atomicWriteJSON(file, restored);
        appendAudit('restore', file, fromSha, toSha);
        return { etag: toSha };
      });
      return send(res, 200, { ok: true, etag: outcome.etag, warnings: v.warnings });
    } catch (e) {
      if (e instanceof LockBusyError) return send(res, 409, { error: 'идёт другая запись, повторите' });
      if (e instanceof EtagMismatchError) {
        return send(res, 409, { error: 'файл изменён вне админки — перезагрузите данные', code: 'etag' });
      }
      if (e instanceof NotFoundError) return send(res, 404, { error: e.message });
      console.error('save error:', e.message);
      return send(res, 500, { error: 'внутренняя ошибка' });
    }
  }


  // ---- служебное: версия работающего сервера (без авторизации, без данных) ----
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true, apiVersion: API_VERSION, startedAt: STARTED_AT });
  }

  // ---- список загруженных изображений (public/previews) ----
  if (req.method === 'GET' && url.pathname === '/api/media') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    const dir = path.join(paths().publicDir, 'previews');
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && /^[a-z0-9][a-z0-9._-]*\.(png|jpg|webp)$/i.test(e.name))
        .map((e) => { const st = fs.statSync(path.join(dir, e.name)); return { name: e.name, path: '/previews/' + e.name, bytes: st.size, mtime: st.mtime.toISOString() }; })
        .sort((a, b) => b.mtime.localeCompare(a.mtime));
    } catch { /* каталога ещё нет */ }
    return send(res, 200, { files });
  }

  // ---- загрузка изображения: тело = байты файла; тип проверяется по СОДЕРЖИМОЮ ----
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    let buf;
    try { buf = await readBody(req, MAX_BYTES + 1024); }
    catch (e) { return send(res, e.code === 'toolarge' ? 413 : 400, { error: e.code === 'toolarge' ? 'файл больше 2 МБ' : 'не удалось прочитать запрос' }); }
    const declared = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const r = inspectImage(buf, declared === 'application/octet-stream' ? undefined : declared);
    if (!r.ok) return send(res, 422, { ok: false, error: r.error });
    // имя формируется сервером: безопасный слаг + случайный суффикс; путь пользователя не используется
    const base = slugify(String(url.searchParams.get('name') || 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '')).slice(0, 40) || 'image';
    const dir = path.join(paths().publicDir, 'previews');
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).length >= MAX_UPLOADS) return send(res, 409, { ok: false, error: 'в каталоге превью слишком много файлов (лимит 300)' });
    const name = `${base}-${crypto.randomBytes(4).toString('hex')}.${r.ext}`;
    const target = path.join(dir, name);
    if (path.dirname(target) !== dir) return send(res, 400, { ok: false, error: 'недопустимое имя' });
    const tmp = path.join(dir, `.upload-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmp, r.data, { mode: 0o644, flag: 'wx' });
      fs.linkSync(tmp, target);                                  // не перезаписывает существующий файл
    } catch (e) {
      return send(res, 500, { ok: false, error: 'не удалось сохранить файл' });
    } finally { try { fs.unlinkSync(tmp); } catch { /* нет файла */ } }
    appendAudit('upload', name, '', crypto.createHash('sha256').update(r.data).digest('hex'));
    return send(res, 200, { ok: true, path: '/previews/' + name, name, width: r.width, height: r.height, bytes: r.data.length, originalBytes: buf.length, cleaned: r.data.length !== buf.length });
  }

  // ---- экспорт всех данных контента одним файлом ----
  if (req.method === 'GET' && url.pathname === '/api/export') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    const data = readAll();
    const bundle = {
      format: 'gonka-blog-content', formatVersion: 1, exportedAt: new Date().toISOString(),
      note: 'Только данные (src/data/*.json). Изображения (public/previews) в пакет не входят.',
      checksums: Object.fromEntries(FILE_NAMES.map((n) => [n, etagOf(n)])),
      files: data,
    };
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
    return send(res, 200, bundle, { 'Content-Disposition': `attachment; filename="gonka-blog-content-${stamp}.json"` });
  }

  // ---- импорт: проверка всего пакета, при dryRun=1 ничего не пишется ----
  if (req.method === 'POST' && url.pathname === '/api/import') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    if (!(req.headers['content-type'] || '').includes('application/json')) return send(res, 415, { error: 'ожидается application/json' });
    let body;
    try { body = JSON.parse((await readBody(req, MAX_IMPORT)).toString('utf8')); }
    catch (e) { return send(res, e.code === 'toolarge' ? 413 : 400, { error: e.code === 'toolarge' ? 'пакет больше 8 МБ' : 'некорректный JSON' }); }
    const dryRun = url.searchParams.get('dryRun') === '1';
    const errors = [], warnings = [];
    const bundle = body && body.bundle;
    if (!bundle || bundle.format !== 'gonka-blog-content' || bundle.formatVersion !== 1 || !bundle.files || typeof bundle.files !== 'object' || Array.isArray(bundle.files)) {
      return send(res, 422, { ok: false, errors: [{ path: 'bundle', message: 'это не пакет GONKA.BLOG (format: gonka-blog-content, formatVersion: 1)' }] });
    }
    const names = Object.keys(bundle.files);
    for (const n of names) if (!FILE_NAMES.includes(n)) errors.push({ path: `files.${n}`, message: 'неизвестный файл данных' });
    if (!names.length) errors.push({ path: 'files', message: 'в пакете нет файлов данных' });
    const current = readAll();
    const next = { ...current };
    for (const n of names.filter((x) => FILE_NAMES.includes(x))) {
      const d = bundle.files[n];
      if (!d || typeof d !== 'object' || Array.isArray(d)) { errors.push({ path: `files.${n}`, message: 'ожидается объект' }); continue; }
      if (bundle.checksums && bundle.checksums[n] && bundle.checksums[n] !== crypto.createHash('sha256').update(serialize(d)).digest('hex')) {
        errors.push({ path: `checksums.${n}`, message: 'контрольная сумма не совпадает — пакет изменён после экспорта' });
      }
      if (n === 'site') normalizeSiteData(d);
      const v = validateFile(n, d);
      errors.push(...v.errors.map((e) => ({ path: `${n}.${e.path}`, message: e.message })));
      warnings.push(...v.warnings.map((e) => ({ path: `${n}.${e.path}`, message: e.message })));
      next[n] = d;
    }
    if (!errors.length) {
      const b = checkBindings({ data: next });
      errors.push(...b.errors.map((e) => ({ path: e.path, message: e.message })));
      warnings.push(...b.warnings);
      if (names.includes('projects')) {
        for (const x of findUnarchivedRemovals(current.projects, next.projects)) errors.push({ path: `projects.${x.group}.${x.id}`, message: `проект «${x.name || x.id}» исчезает из данных без архивации — сначала переведите его в архив` });
      }
    }
    if (errors.length) return send(res, 422, { ok: false, errors, warnings });
    const changed = names.filter((n) => serialize(next[n]) !== serialize(current[n]));
    if (dryRun || !changed.length) return send(res, 200, { ok: true, dryRun, changed, unchanged: names.filter((n) => !changed.includes(n)), warnings });
    try {
      const backups = withLock(() => changed.map((n) => { const backup = createBackup(n); const { fromSha, toSha } = atomicWriteJSON(n, next[n]); appendAudit('import', n, fromSha, toSha); return { file: n, backup }; }));
      return send(res, 200, { ok: true, dryRun: false, changed, backups, warnings, etags: allEtags() });
    } catch (e) {
      if (e instanceof LockBusyError) return send(res, 409, { ok: false, error: 'идёт другая запись, повторите' });
      console.error('import error:', e.message);
      return send(res, 500, { ok: false, error: 'внутренняя ошибка' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/releases') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    return send(res, 200, { mode: releaseMode() ? 'releases' : 'local', ...listReleases() });
  }

  if (req.method === 'POST' && url.pathname === '/api/rollback') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    if (!releaseMode()) return send(res, 400, { error: 'режим релизов не включён' });
    if (publishing) return send(res, 409, { error: 'идёт публикация, повторите позже' });
    try {
      let name;
      const raw = await readBody(req);
      if (raw.length) name = JSON.parse(raw.toString('utf8')).name;
      const r = rollback(name);
      appendAudit('rollback', 'site', r.from || '', r.to);
      return send(res, 200, { ok: true, ...r });
    } catch (e) {
      return send(res, 400, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/publish') {
    if (rateLimited(ip)) return send(res, 429, { error: 'слишком много попыток, подождите' });
    if (!authOk(req)) { registerFail(ip); return send(res, 401, { error: 'нет токена' }); }
    resetFails(ip);
    if (publishing) return send(res, 409, { ok: false, error: 'публикация уже идёт' });
    publishing = true;

    let releaseName = null;
    try {
      // 1. Валидация всех JSON файлов
      const all = readAll();
      const validationErrors = [];
      for (const name of FILE_NAMES) {
        const v = validateFile(name, all[name]);
        if (v.errors.length) {
          validationErrors.push(...v.errors.map(err => `[${name}] ${err.path}: ${err.message}`));
        }
      }
      const b = checkBindings({ data: all });
      if (b.errors.length) {
        validationErrors.push(...b.errors.map(err => `[bindings] ${err.path}: ${err.message}`));
      }
      if (validationErrors.length) {
        return send(res, 422, { ok: false, error: 'Ошибки валидации данных', details: validationErrors });
      }

      // дочерним процессам токен не передаём
      const childEnv = { ...process.env };
      delete childEnv.ADMIN_TOKEN;
      const opts = { cwd: ROOT, env: childEnv, timeout: 5 * 60_000, maxBuffer: 10 * 1024 * 1024 };

      // 2. Режим релизов: сборка в отдельную папку, живой сайт не затрагивается до переключения
      if (releaseMode()) {
        releaseName = newReleaseName();
        const outDir = releasePath(releaseName);
        const build = await execFileAsync('npm', ['run', 'build', '--', '--outDir', outDir], opts);
        await execFileAsync(process.execPath, [path.join(HERE, 'verify-dist.mjs'), '--dist', outDir], opts);
        const previous = listReleases().current;
        activate(releaseName);
        const removed = prune();
        appendAudit('publish', 'site', previous || '', releaseName);
        const git = await commitContent(`content: update via admin (${releaseName})`);
        return send(res, 200, {
          ok: true,
          mode: 'releases',
          message: `Релиз ${releaseName} собран, проверен и активирован`,
          release: releaseName,
          previous,
          pruned: removed,
          git,
          timestamp: new Date().toISOString(),
          buildLog: String(build.stdout).slice(-1500),
          warnings: b.warnings,
        });
      }

      // 2'. Локальный режим: сборка в dist
      await execFileAsync('npm', ['run', 'build'], opts);
      if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
        return send(res, 500, { ok: false, error: 'Сборка не создала dist/index.html' });
      }
      await execFileAsync('npm', ['run', 'verify:dist'], opts);
      appendAudit('publish', 'all', '', 'local_build');
      return send(res, 200, {
        ok: true,
        mode: 'local',
        message: 'Проект успешно проверен и собран в dist/',
        timestamp: new Date().toISOString(),
        buildSummary: 'Сборка dist/ завершена успешно (exit code 0)',
        warnings: b.warnings,
      });
    } catch (err) {
      console.error('publish error:', err.message);
      // неудачный релиз удаляем; активный не меняется
      if (releaseName) {
        try { fs.rmSync(releasePath(releaseName), { recursive: true, force: true }); } catch { /* ignore */ }
      }
      return send(res, 500, {
        ok: false,
        error: 'Ошибка публикации/сборки: ' + String(err.stdout || err.stderr || err.message).slice(-1500),
        activeRelease: releaseMode() ? listReleases().current : undefined,
      });
    } finally {
      publishing = false;
    }
  }

  return send(res, 404, { error: 'нет такого API' });
}

const STATIC = {
  '/': [path.join(HERE, 'ui', 'index.html'), 'text/html; charset=utf-8'],
  '/index.html': [path.join(HERE, 'ui', 'index.html'), 'text/html; charset=utf-8'],
  '/ui/app.js': [path.join(HERE, 'ui', 'app.js'), 'application/javascript; charset=utf-8'],
  '/ui/style.css': [path.join(HERE, 'ui', 'style.css'), 'text/css; charset=utf-8'],
  '/ui/project-ops.mjs': [path.join(HERE, 'lib', 'project-ops.mjs'), 'application/javascript; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const ts = new Date().toISOString();

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      console.log(`${ts} ${req.method} ${url.pathname} ${res.statusCode}`);
      return;
    }
    // изображения из public/previews для миниатюр в админке (только безопасные имена, только PNG/JPEG/WebP)
    const pm = req.method === 'GET' && url.pathname.match(/^\/previews\/([a-z0-9][a-z0-9._-]*\.(png|jpg|webp))$/);
    if (pm) {
      if (!hostOk(req)) { send(res, 403, { error: 'запрос не с localhost' }); return; }
      const file = path.join(paths().publicDir, 'previews', pm[1]);
      if (!fs.existsSync(file)) { send(res, 404, { error: 'not found' }); return; }
      const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[pm[2]];
      sendFile(res, file, type);
      return;
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [abs, type] = STATIC[url.pathname];
      if (!hostOk(req)) { send(res, 403, { error: 'запрос не с localhost' }); return; }
      sendFile(res, abs, type);
      console.log(`${ts} ${req.method} ${url.pathname} 200`);
      return;
    }
    send(res, 404, { error: 'not found' });
    console.log(`${ts} ${req.method} ${url.pathname} 404`);
  } catch (e) {
    console.error(`${ts} error:`, e.message);
    if (!res.headersSent) send(res, 500, { error: 'внутренняя ошибка' });
  }
});

// --- старт ---
ensureDirs();
cleanupTmp();
try {
  const data = readAll();
  let bad = 0;
  for (const name of FILE_NAMES) bad += validateFile(name, data[name]).errors.length;
  const b = checkBindings({ data });
  console.log(`данные: ${bad === 0 && b.errors.length === 0 ? 'OK' : `ОШИБКИ схем=${bad} привязок=${b.errors.length}`}` +
    `, предупреждений привязок: ${b.warnings.length}`);
} catch (e) {
  console.log('ВНИМАНИЕ: данные не читаются —', e.message);
}

server.listen(PORT, HOST, () => {
  console.log(`GONKA admin → http://127.0.0.1:${PORT}${PUBLIC_ORIGIN ? ` (публичный адрес: ${PUBLIC_ORIGIN})` : ''}`);
  console.log(`режим публикации: ${releaseMode() ? 'релизы → ' + releaseConfig().releasesDir : 'локальный dist'}`);
  console.log(`токен: ${process.env.ADMIN_TOKEN ? 'из переменной ADMIN_TOKEN' : 'файл tools/admin/.token (посмотреть: cat tools/admin/.token)'}`);
  console.log(`данные: ${path.relative(ROOT, path.join(process.env.ADMIN_DATA_DIR || path.join(ROOT, 'src', 'data')))}`);
  console.log('для остановки: Ctrl+C');
});
