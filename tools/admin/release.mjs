#!/usr/bin/env node
// tools/admin/release.mjs — релизы публичного сайта (symlink-схема) и коммит контента в ветку content.
// Режим релизов включается переменной ADMIN_RELEASES_DIR. Без неё админка собирает только локальный dist.
//   BASE/releases/<имя>/   — собранные версии сайта
//   BASE/current           — симлинк на активный релиз (на него указывает nginx root)
// CLI: node tools/admin/release.mjs list | rollback [имя] | activate <имя>
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATA_FILES = ['site', 'links', 'media', 'sections', 'projects'].map((n) => `src/data/${n}.json`);

export function config() {
  const releasesDir = process.env.ADMIN_RELEASES_DIR ? path.resolve(process.env.ADMIN_RELEASES_DIR) : null;
  return {
    releasesDir,
    currentLink: process.env.ADMIN_CURRENT_LINK
      ? path.resolve(process.env.ADMIN_CURRENT_LINK)
      : releasesDir && path.join(path.dirname(releasesDir), 'current'),
    keep: Math.max(2, Number(process.env.ADMIN_RELEASES_KEEP || 5)),
    gitPush: process.env.ADMIN_GIT_PUSH === '1',
    branch: process.env.ADMIN_CONTENT_BRANCH || 'content',
    remote: process.env.ADMIN_GIT_REMOTE || 'origin',
  };
}

export function releaseMode() {
  return config().releasesDir !== null;
}

export function newReleaseName() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export function releasePath(name) {
  const { releasesDir } = config();
  if (!releasesDir) throw new Error('режим релизов не включён (ADMIN_RELEASES_DIR)');
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('недопустимое имя релиза');
  return path.join(releasesDir, name);
}

export function currentRelease() {
  const { currentLink } = config();
  try {
    return path.basename(fs.realpathSync(currentLink));
  } catch {
    return null;
  }
}

export function listReleases() {
  const { releasesDir } = config();
  if (!releasesDir || !fs.existsSync(releasesDir)) return { releases: [], current: currentRelease() };
  const releases = fs.readdirSync(releasesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && NAME_RE.test(e.name) && fs.existsSync(path.join(releasesDir, e.name, 'index.html')))
    .map((e) => e.name)
    .sort();
  return { releases, current: currentRelease() };
}

// Атомарное переключение: временный симлинк + rename поверх current.
export function activate(name) {
  const { currentLink } = config();
  const dir = releasePath(name);
  if (!fs.existsSync(path.join(dir, 'index.html'))) throw new Error(`релиз ${name} не содержит index.html`);
  if (fs.existsSync(currentLink) && !fs.lstatSync(currentLink).isSymbolicLink()) {
    throw new Error(`${currentLink} не симлинк — переключение остановлено, миграцию делает Deploy Agent`);
  }
  const tmp = `${currentLink}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.relative(path.dirname(currentLink), dir), tmp);
  fs.renameSync(tmp, currentLink);
}

export function prune() {
  const { keep } = config();
  const { releases, current } = listReleases();
  const removable = releases.filter((r) => r !== current).slice(0, Math.max(0, releases.length - keep));
  for (const r of removable) fs.rmSync(releasePath(r), { recursive: true, force: true });
  return removable;
}

export function rollback(name) {
  const { releases, current } = listReleases();
  let target = name;
  if (!target) {
    const i = releases.indexOf(current);
    target = i > 0 ? releases[i - 1] : null;
  }
  if (!target) throw new Error('нет предыдущего релиза для отката');
  if (!releases.includes(target)) throw new Error(`релиз ${target} не найден`);
  activate(target);
  return { from: current, to: target };
}

// Коммит только src/data/*.json в ветку content и push (если ADMIN_GIT_PUSH=1). Force-push не используется.
export async function commitContent(message) {
  const c = config();
  const git = (args, opts = {}) => execFileAsync('git', args, { cwd: ROOT, timeout: 60_000, ...opts });
  try {
    const { stdout: branch } = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch.trim() !== c.branch) {
      return { ok: false, skipped: true, error: `рабочая копия на ветке «${branch.trim()}», ожидается «${c.branch}»` };
    }
    const { stdout: st } = await git(['status', '--porcelain', '--', ...DATA_FILES]);
    if (!st.trim()) return { ok: true, changed: false };
    await git(['add', '--', ...DATA_FILES]);
    await git(['-c', `user.name=${process.env.ADMIN_GIT_NAME || 'GONKA Admin'}`,
      '-c', `user.email=${process.env.ADMIN_GIT_EMAIL || 'admin@gonka.blog'}`,
      'commit', '-m', message, '--', ...DATA_FILES]);
    const { stdout: sha } = await git(['rev-parse', '--short', 'HEAD']);
    if (!c.gitPush) return { ok: true, changed: true, commit: sha.trim(), pushed: false };
    await git(['push', c.remote, `HEAD:refs/heads/${c.branch}`]);
    return { ok: true, changed: true, commit: sha.trim(), pushed: true };
  } catch (e) {
    return { ok: false, error: String(e.stderr || e.message).trim().slice(0, 500) };
  }
}

// IP клиента: X-Real-IP принимается только при ADMIN_TRUST_PROXY=1 и только от loopback-proxy.
export function clientIp(req) {
  const sock = req.socket.remoteAddress || '?';
  if (process.env.ADMIN_TRUST_PROXY === '1' && /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(sock)) {
    const xr = String(req.headers['x-real-ip'] || '').trim();
    if (net.isIP(xr)) return xr;
  }
  return sock;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'list') console.log(JSON.stringify(listReleases(), null, 2));
    else if (cmd === 'rollback') console.log(JSON.stringify(rollback(arg)));
    else if (cmd === 'activate' && arg) { activate(arg); console.log(JSON.stringify({ current: currentRelease() })); }
    else { console.error('usage: release.mjs list | rollback [имя] | activate <имя>'); process.exit(2); }
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
}
