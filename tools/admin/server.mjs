#!/usr/bin/env node
// tools/admin/server.mjs — локальный сервер админки GONKA.BLOG.
// Только 127.0.0.1, Bearer-токен (файл .token, 0600), валидация схемами,
// allowlist ссылок, атомарная запись, лок, бэкап перед сохранением, audit.log.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  ROOT, FILE_NAMES, readAll, allEtags, etagOf, serialize,
  withLock, atomicWriteJSON, createBackup, listBackups, readBackupJSON,
  appendAudit, cleanupTmp, ensureDirs, LockBusyError, EtagMismatchError, NotFoundError,
} from './store.mjs';
import { validateFile } from './validate.mjs';
import { checkBindings } from './bindings.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ADMIN_PORT || 4310);
const HOST = '127.0.0.1';
const MAX_BODY = 1024 * 1024; // 1 МБ

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
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // не храним данные, но дочитываем запрос, чтобы клиент получил ответ 413,
        // а не обрыв соединения; жёсткий предохранитель — 8 МБ
        tooLarge = true;
        chunks.length = 0;
        if (size > 8 * MAX_BODY) {
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
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return false;
  return tokenMatches(h.slice(7).trim());
}

function hostOk(req) {
  const host = (req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost';
}

function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const u = new URL(o);
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
  const ip = req.socket.remoteAddress || '?';

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
        const v = validateWithBindings(file, data);
        if (v.errors.length) return send(res, 422, { errors: v.errors, warnings: v.warnings });

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

  return send(res, 404, { error: 'нет такого API' });
}

const STATIC = {
  '/': [path.join(HERE, 'ui', 'index.html'), 'text/html; charset=utf-8'],
  '/index.html': [path.join(HERE, 'ui', 'index.html'), 'text/html; charset=utf-8'],
  '/ui/app.js': [path.join(HERE, 'ui', 'app.js'), 'application/javascript; charset=utf-8'],
  '/ui/style.css': [path.join(HERE, 'ui', 'style.css'), 'text/css; charset=utf-8'],
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
  console.log(`GONKA admin → http://127.0.0.1:${PORT}`);
  console.log(`токен: ${process.env.ADMIN_TOKEN ? 'из переменной ADMIN_TOKEN' : 'файл tools/admin/.token (посмотреть: cat tools/admin/.token)'}`);
  console.log(`данные: ${path.relative(ROOT, path.join(process.env.ADMIN_DATA_DIR || path.join(ROOT, 'src', 'data')))}`);
  console.log('для остановки: Ctrl+C');
});
