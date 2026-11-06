// Local visual review bridge. Run only in the user's normal terminal.
// Commands are read from .preview-bridge/request.json; no shell commands or arbitrary URLs are accepted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../scene/cdp.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, '.preview-bridge');
const requestFile = path.join(dir, 'request.json');
const resultFile = path.join(dir, 'result.json');
const screenshot = path.join(dir, 'screen.png');
const base = 'http://127.0.0.1:4352/';
fs.mkdirSync(dir, { recursive: true });
const write = (file, value) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2)); fs.renameSync(tmp, file); };
let browser;
try {
  browser = await launch({ width: 1440, height: 900, port: 9511 });
  await browser.goto(base, 1800);
  await browser.shot(screenshot);
  write(resultFile, { id: 'startup', ok: true, screenshot: 'screen.png', title: await browser.eval('document.title'), errors: browser.jsErrors() });
  console.log('Визуальный помощник запущен. Оставьте это окно открытым. Для остановки нажмите Ctrl+C.');
} catch (error) {
  write(resultFile, { id: 'startup', ok: false, error: String(error) });
  console.error('Не удалось запустить Chrome или открыть локальный сайт:', error);
  browser?.close(); process.exit(1);
}
let running = false;
const timer = setInterval(async () => {
  if (running || !fs.existsSync(requestFile)) return;
  running = true;
  let req;
  try {
    req = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
    fs.unlinkSync(requestFile);
    if (typeof req.id !== 'string' || req.id.length > 100) throw new Error('Некорректный id');
    if (req.action === 'reset') await browser.goto(base, 900);
    else if (req.action === 'click' || req.action === 'hover') {
      if (typeof req.selector !== 'string' || req.selector.length > 200) throw new Error('Некорректный селектор');
      const rect = await browser.eval(`(() => { const el = document.querySelector(${JSON.stringify(req.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height }; })()`);
      if (!rect || !rect.w || !rect.h) throw new Error('Элемент не найден или не виден');
      await browser.move(rect.x, rect.y);
      if (req.action === 'click') {
        await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      }
      await browser.wait(900);
    } else if (req.action === 'resize') {
      const width = Math.max(320, Math.min(1920, Number(req.width) || 1440));
      const height = Math.max(480, Math.min(1200, Number(req.height) || 900));
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 600 });
      await browser.wait(600);
    } else if (req.action !== 'snapshot') throw new Error('Неизвестное действие');
    await browser.shot(screenshot);
    const state = await browser.eval(`({ title: document.title, url: location.href, open: [...document.querySelectorAll('.workbench-drawer.is-open')].map(x => x.id), viewport: [innerWidth, innerHeight] })`);
    write(resultFile, { id: req.id, ok: true, screenshot: 'screen.png', state, errors: browser.jsErrors() });
  } catch (error) { write(resultFile, { id: req?.id || 'unknown', ok: false, error: String(error) }); }
  finally { running = false; }
}, 400);
const shutdown = () => { clearInterval(timer); browser?.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
