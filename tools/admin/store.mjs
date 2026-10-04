// tools/admin/store.mjs — хранение, атомарная запись, лок, бэкапы, audit.
// Зона записи: только src/data/*.json (или ADMIN_DATA_DIR для тестов).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

export const FILE_NAMES = ['site', 'links', 'media', 'sections', 'projects', 'scene'];
const LOCK_STALE_MS = 30_000;
const BACKUP_MAX_COUNT = 100;
const BACKUP_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export class LockBusyError extends Error {
  constructor() { super('admin lock is busy'); this.code = 'lock'; }
}
export class EtagMismatchError extends Error {
  constructor() { super('file changed since load'); this.code = 'etag'; }
}
export class NotFoundError extends Error {
  constructor(m) { super(m || 'not found'); this.code = 'notfound'; }
}

function envPath(name, fallback) {
  const v = process.env[name];
  return v ? path.resolve(v) : fallback;
}

export function paths() {
  const data = envPath('ADMIN_DATA_DIR', path.join(ROOT, 'src', 'data'));
  return {
    root: ROOT,
    data,
    tmp: path.join(data, '.tmp'),
    backups: path.join(data, '.backups'),
    lock: path.join(data, '.admin.lock'),
    audit: envPath('ADMIN_AUDIT_FILE', path.join(HERE, 'audit.log')),
    token: envPath('ADMIN_TOKEN_FILE', path.join(HERE, '.token')),
    publicDir: envPath('ADMIN_PUBLIC_DIR', path.join(ROOT, 'public')),
    schemaDir: path.join(HERE, 'schema'),
  };
}

export function filePath(name) {
  if (!FILE_NAMES.includes(name)) throw new NotFoundError('unknown file: ' + name);
  return path.join(paths().data, name + '.json');
}

export function ensureDirs() {
  const p = paths();
  fs.mkdirSync(p.data, { recursive: true });
  fs.mkdirSync(p.tmp, { recursive: true });
  fs.mkdirSync(p.backups, { recursive: true });
}

export function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function readRaw(name) {
  return fs.readFileSync(filePath(name));
}

export function readJSON(name) {
  const raw = readRaw(name);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new Error(`${name}.json: invalid JSON — ${e.message}`);
  }
}

export function readAll() {
  const out = {};
  for (const n of FILE_NAMES) out[n] = readJSON(n);
  return out;
}

export function etagOf(name) {
  return sha(readRaw(name));
}

export function allEtags() {
  const out = {};
  for (const n of FILE_NAMES) out[n] = etagOf(n);
  return out;
}

export function serialize(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function fsyncDirBestEffort(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best effort: не критично на darwin */ }
}

// Атомарная запись: tmp в той же ФС → fsync → rename поверх цели.
export function atomicWriteJSON(name, obj) {
  ensureDirs();
  const p = paths();
  const target = filePath(name);
  const fromSha = sha(fs.readFileSync(target));
  const tmp = path.join(
    p.tmp,
    `${name}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  const buf = Buffer.from(serialize(obj), 'utf8');
  const fd = fs.openSync(tmp, 'wx', 0o644);
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  fsyncDirBestEffort(p.data);
  return { fromSha, toSha: sha(buf) };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function lockInfo() {
  try {
    return JSON.parse(fs.readFileSync(paths().lock, 'utf8'));
  } catch { return null; }
}

function lockIsStale(info) {
  if (!info || !Number.isFinite(info.startedAt)) return true;
  if (Date.now() - info.startedAt > LOCK_STALE_MS) return true;
  return !pidAlive(info.pid);
}

export function withLock(fn) {
  ensureDirs();
  const p = paths();
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    owner: crypto.randomUUID(),
  });
  let mine = false;
  try {
    fs.writeFileSync(p.lock, payload, { flag: 'wx', mode: 0o600 });
    mine = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const info = lockInfo();
    if (lockIsStale(info)) {
      try { fs.unlinkSync(p.lock); } catch { /* ignore */ }
      fs.writeFileSync(p.lock, payload, { flag: 'wx', mode: 0o600 });
      mine = true;
    } else {
      throw new LockBusyError();
    }
  }
  try {
    return fn();
  } finally {
    if (mine) {
      const info = lockInfo();
      if (info && info.owner === JSON.parse(payload).owner) {
        try { fs.unlinkSync(p.lock); } catch { /* ignore */ }
      }
    }
  }
}

const BACKUP_RE = /^(site|links|media|sections)\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z\.json$/;

export function createBackup(name) {
  ensureDirs();
  const p = paths();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${name}.${ts}.json`;
  fs.copyFileSync(filePath(name), path.join(p.backups, backupName));
  pruneBackups();
  return backupName;
}

export function listBackups() {
  const p = paths();
  let names;
  try { names = fs.readdirSync(p.backups); } catch { return []; }
  return names
    .filter((n) => BACKUP_RE.test(n))
    .map((n) => {
      const st = fs.statSync(path.join(p.backups, n));
      return { name: n, file: n.split('.')[0], mtimeMs: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function pruneBackups() {
  const p = paths();
  const all = listBackups();
  const now = Date.now();
  const byFile = new Map();
  for (const b of all) {
    if (now - b.mtimeMs > BACKUP_MAX_AGE_MS || (byFile.get(b.file)?.length ?? 0) >= BACKUP_MAX_COUNT) {
      try { fs.unlinkSync(path.join(p.backups, b.name)); } catch { /* ignore */ }
      continue;
    }
    if (!byFile.has(b.file)) byFile.set(b.file, []);
    byFile.get(b.file).push(b.name);
  }
}

export function backupPath(backupName) {
  if (!BACKUP_RE.test(backupName)) throw new NotFoundError('bad backup name');
  const p = path.join(paths().backups, backupName);
  if (!fs.existsSync(p)) throw new NotFoundError('backup not found');
  return p;
}

export function readBackupJSON(backupName) {
  const raw = fs.readFileSync(backupPath(backupName));
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new Error(`backup ${backupName}: invalid JSON — ${e.message}`);
  }
}

export function appendAudit(action, file, fromSha, toSha) {
  const p = paths();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    action,
    file,
    fromSha,
    toSha,
  }) + '\n';
  fs.appendFileSync(p.audit, line, { mode: 0o600 });
}

export function cleanupTmp() {
  const p = paths();
  let names = [];
  try { names = fs.readdirSync(p.tmp); } catch { return; }
  for (const n of names) {
    if (!n.endsWith('.tmp')) continue;
    try { fs.unlinkSync(path.join(p.tmp, n)); } catch { /* ignore */ }
  }
}
