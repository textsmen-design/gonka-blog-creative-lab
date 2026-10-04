#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCREENSHOTS_DIR = path.join(HERE, 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROME_PORT = 9225;
const TOKEN = fs.readFileSync(path.join(HERE, '.token'), 'utf8').trim();

console.log('=== ЗАПУСК ЦЕЛЕВОЙ ПРОВЕРКИ «ТАСК-ТРЕКЕРЫ» И АДМИНКИ ===');

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  `--remote-debugging-port=${CHROME_PORT}`,
  '--user-data-dir=/tmp/chrome-verify-trackers',
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

async function takeScreenshot(filename) {
  const res = await sendCDP('Page.captureScreenshot', { format: 'png' });
  const p = path.join(SCREENSHOTS_DIR, filename);
  fs.writeFileSync(p, Buffer.from(res.data, 'base64'));
  console.log(`  [Скриншот сохранён]: ${filename}`);
  return p;
}

await sendCDP('Page.enable');
await sendCDP('Runtime.enable');
await sendCDP('DOM.enable');

// 1. Проверка верстака на http://127.0.0.1:4321/
console.log('\n--- 1. ПРОВЕРКА ВЕРСТАКА (http://127.0.0.1:4321/) ---');
await sendCDP('Page.navigate', { url: 'http://127.0.0.1:4321/' });
await new Promise(r => setTimeout(r, 2000));

// Проверяем надпись на плашке трекеров
const trackersPlankInfo = await evalInPage(`(() => {
  const btn = document.querySelector('.hotspot-trackers');
  const tag = btn?.querySelector('.editorial-tag')?.textContent?.trim();
  const stmt = btn?.querySelector('.editorial-statement')?.textContent?.trim();
  btn?.classList.add('is-hovered');
  const rect = btn?.getBoundingClientRect();
  return { tag, stmt, rect };
})()`);

console.log('Плашка трекеров tag:', trackersPlankInfo.tag);
console.log('Плашка трекеров statement:', trackersPlankInfo.stmt);
await takeScreenshot('task_trackers_hover.png');

// Клик по плашке трекеров
await evalInPage(`document.querySelector('.hotspot-trackers').click()`);
await new Promise(r => setTimeout(r, 600));

const trackersDrawer = await evalInPage(`(() => {
  const d = document.getElementById('modal-trackers');
  return {
    isOpen: d?.classList.contains('is-open'),
    title: d?.querySelector('.case-title')?.textContent,
    headerTag: d?.querySelector('.drawer-tag')?.textContent,
  };
})()`);
console.log('Панель трекеров открыта:', trackersDrawer.isOpen, '| заголовок:', trackersDrawer.title);
await takeScreenshot('task_trackers_drawer.png');

await evalInPage(`document.querySelector('#modal-trackers .close-drawer-btn').click()`);
await new Promise(r => setTimeout(r, 400));

// Проверка SRBIJA
const srbijaInfo = await evalInPage(`(() => {
  const btn = document.querySelector('.hotspot-srbija');
  const tag = btn?.querySelector('.editorial-tag')?.textContent?.trim();
  const stmt = btn?.querySelector('.editorial-statement')?.textContent?.trim();
  return { tag, stmt };
})()`);
console.log('Плашка SRBIJA tag:', srbijaInfo.tag, '| stmt:', srbijaInfo.stmt);

await evalInPage(`document.querySelector('.hotspot-srbija').click()`);
await new Promise(r => setTimeout(r, 600));
const srbijaDrawer = await evalInPage(`(() => {
  const d = document.getElementById('modal-srbija');
  const link = d?.querySelector('a[href*="reloca.gonka.blog"]')?.href;
  return {
    isOpen: d?.classList.contains('is-open'),
    title: d?.querySelector('.case-title')?.textContent,
    hasRelocaLink: !!link,
    relocaUrl: link
  };
})()`);
console.log('Панель SRBIJA открыта:', srbijaDrawer.isOpen, '| reloca ссылка:', srbijaDrawer.relocaUrl);
await takeScreenshot('srbija_drawer_verified.png');

// 2. Проверка админки на http://127.0.0.1:4310/
console.log('\n--- 2. ПРОВЕРКА АДМИНКИ (http://127.0.0.1:4310/) ---');
await sendCDP('Page.navigate', { url: 'http://127.0.0.1:4310/' });
await new Promise(r => setTimeout(r, 1500));

// Авторизация
await evalInPage(`(() => {
  document.getElementById('gate-token').value = '${TOKEN}';
  document.getElementById('gate-form').dispatchEvent(new Event('submit', { cancelable: true }));
})()`);
await new Promise(r => setTimeout(r, 800));

// Переход на вкладку «Сайт»
await evalInPage(`(() => {
  const btns = Array.from(document.querySelectorAll('#tabs button'));
  const b = btns.find(btn => btn.textContent.trim() === 'Сайт');
  if (b) b.click();
})()`);
await new Promise(r => setTimeout(r, 600));

const adminDeskLabels = await evalInPage(`(() => {
  const keys = Array.from(document.querySelectorAll('#editor .obj-key')).map(k => k.textContent.trim());
  return keys;
})()`);
console.log('Ключи и подписи в редакторе «Сайт»:', adminDeskLabels);
await takeScreenshot('admin_site_tab_desk.png');

// Проверка редактирования и сохранения в админке
console.log('\nПроверка: редактирование надписи через админку и сохранение...');
const saveResult = await evalInPage(`(async () => {
  // Находим поле tag внутри modal-trackers
  const allFields = Array.from(document.querySelectorAll('#editor .field'));
  let trackerTagField = null;
  for (const f of allFields) {
    const label = f.querySelector('label')?.textContent || '';
    const parentObj = f.closest('.obj');
    const objKey = parentObj?.querySelector('.obj-key')?.textContent || '';
    if (objKey.includes('modal-trackers') && label.includes('tag')) {
      trackerTagField = f.querySelector('textarea');
      break;
    }
  }
  if (!trackerTagField) {
    return { ok: false, error: 'Поле tag для modal-trackers не найдено' };
  }
  
  const initialValue = trackerTagField.value;
  
  // Вводим текст
  trackerTagField.value = 'ТАСК-ТРЕКЕРЫ';
  trackerTagField.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  
  // Открываем окно подтверждения изменений (diff)
  document.getElementById('btn-save').click();
  await new Promise(r => setTimeout(r, 300));
  
  const diffVisible = !document.getElementById('diffbox').hidden;
  
  // Подтверждаем и сохраняем
  document.getElementById('btn-confirm').click();
  await new Promise(r => setTimeout(r, 1200));
  
  const noticeOk = document.querySelector('.notice.ok')?.textContent || '';
  const noticeErr = document.querySelector('.notice.err')?.textContent || '';
  
  return {
    ok: !noticeErr && !!noticeOk,
    initialValue,
    diffVisible,
    noticeOk,
    noticeErr
  };
})()`);

console.log('Результат сохранения в админке:', saveResult);
await takeScreenshot('admin_site_saved_ok.png');

ws.close();
chrome.kill();
console.log('\n=== ЦЕЛЕВАЯ ПРОВЕРКА УСПЕШНО ЗАВЕРШЕНА ===\n');
process.exit(0);
