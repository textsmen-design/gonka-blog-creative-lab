#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCREENSHOTS_DIR = path.join(HERE, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROME_PORT = 9230;

console.log('=== ЗАПУСК ФИНАЛЬНОЙ СЪЁМКИ ВЕРСТАКА И ПЛАШКИ ===');

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  `--remote-debugging-port=${CHROME_PORT}`,
  '--user-data-dir=/tmp/chrome-final-verify',
  '--window-size=1440,900',
  '--no-first-run',
  '--no-default-browser-check'
]);

let version = null;
for (let i = 0; i < 15; i++) {
  try {
    const versionRes = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
    if (versionRes.ok) {
      version = await versionRes.json();
      break;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 400));
}
if (!version) {
  throw new Error('Не удалось подключиться к Chrome CDP на порту ' + CHROME_PORT);
}
console.log('Chrome подключен:', version.Browser);

const newTabRes = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new?about:blank`, { method: 'PUT' });
const tab = await newTabRes.json();
const wsUrl = tab.webSocketDebuggerUrl;

let idCounter = 1;
const callbacks = new Map();
const ws = new globalThis.WebSocket(wsUrl);

await new Promise((resolve) => {
  ws.onopen = resolve;
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      const cb = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      if (msg.error) cb.reject(new Error(msg.error.message));
      else cb.resolve(msg.result);
    }
  };
});

function sendCDP(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = idCounter++;
    callbacks.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInPage(expr) {
  const res = await sendCDP('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || 'Eval error');
  }
  return res.result?.value;
}

async function takeScreenshot(filename, clip = null) {
  const params = { format: 'png' };
  if (clip) params.clip = clip;
  const res = await sendCDP('Page.captureScreenshot', params);
  const p = path.join(SCREENSHOTS_DIR, filename);
  fs.writeFileSync(p, Buffer.from(res.data, 'base64'));
  console.log(`  [Скриншот сохранён]: ${filename}`);
  return p;
}

await sendCDP('Page.enable');
await sendCDP('Runtime.enable');
await sendCDP('DOM.enable');

// Переход на верстак
await sendCDP('Page.navigate', { url: 'http://127.0.0.1:4321/' });
await new Promise(r => setTimeout(r, 2000));

// 1. Полная композиция стола
console.log('1. Снимок всей композиции стола...');
await takeScreenshot('01_workbench_overview_final.png');

// 2. Крупный план изменённой плашки
console.log('2. Крупный план плашки «ТАСК-ТРЕКЕРЫ»...');
const plankRect = await evalInPage(`(() => {
  const btn = document.querySelector('.hotspot-trackers');
  const r = btn.getBoundingClientRect();
  return {
    x: Math.max(0, Math.floor(r.x - 20)),
    y: Math.max(0, Math.floor(r.y - 20)),
    width: Math.ceil(r.width + 40),
    height: Math.ceil(r.height + 40),
    scale: 1
  };
})()`);

await takeScreenshot('02_trackers_plank_closeup.png', plankRect);

// 3. Плашка в состоянии наведения (hover)
console.log('3. Ховер-состояние плашки...');
await evalInPage(`(() => {
  const btn = document.querySelector('.hotspot-trackers');
  btn.classList.add('is-hovered');
})()`);
await new Promise(r => setTimeout(r, 300));
await takeScreenshot('03_trackers_hover_state.png', plankRect);
await evalInPage(`document.querySelector('.hotspot-trackers').classList.remove('is-hovered')`);

// 4. Открытие карточки трекеров
console.log('4. Открытие каталога трекеров...');
await evalInPage(`document.querySelector('.hotspot-trackers').click()`);
await new Promise(r => setTimeout(r, 600));
const trackersDrawerOpen = await evalInPage(`document.getElementById('modal-trackers').classList.contains('is-open')`);
console.log('  Drawer modal-trackers is-open:', trackersDrawerOpen);
await takeScreenshot('04_trackers_drawer_opened.png');
await evalInPage(`document.querySelector('#modal-trackers .close-drawer-btn').click()`);
await new Promise(r => setTimeout(r, 400));

// 5. Открытие SRBIJA
console.log('5. Открытие проекта SRBIJA...');
await evalInPage(`document.querySelector('.hotspot-srbija').click()`);
await new Promise(r => setTimeout(r, 600));
const srbijaDrawerOpen = await evalInPage(`document.getElementById('modal-srbija').classList.contains('is-open')`);
console.log('  Drawer modal-srbija is-open:', srbijaDrawerOpen);
await takeScreenshot('05_srbija_drawer_opened.png');

ws.close();
chrome.kill();
console.log('=== СЪЁМКА УСПЕШНО ЗАВЕРШЕНА ===');
process.exit(0);
