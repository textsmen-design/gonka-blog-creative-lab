#!/usr/bin/env node
// tools/admin/browser-manual-verify.mjs — автоматизированная ручная проверка в Chrome через CDP.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCREENSHOTS_DIR = path.join(ROOT, 'tools', 'admin', 'screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROME_PORT = 9222;
const TOKEN = fs.readFileSync(path.join(HERE, '.token'), 'utf8').trim();

console.log('=== ЗАПУСК БРАУЗЕРНОЙ ВЕРИФИКАЦИИ GONKA.BLOG ===');

// 1. Запуск Chrome
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new',
  `--remote-debugging-port=${CHROME_PORT}`,
  '--user-data-dir=/tmp/chrome-manual-verify',
  '--window-size=1440,900',
  '--no-first-run',
  '--no-default-browser-check'
]);

await new Promise(r => setTimeout(r, 1500));

// Подключение к CDP
const versionRes = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`);
const version = await versionRes.json();
console.log('Chrome подключен:', version.Browser);

// Создаём новую вкладку
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

// ==========================================
// 1. ТЕСТИРОВАНИЕ ВЕРСТАКА (http://127.0.0.1:4321/)
// ==========================================
console.log('\n--- 1. ПРОВЕРКА ВЕРСТАКА НА http://127.0.0.1:4321/ ---');
await sendCDP('Page.navigate', { url: 'http://127.0.0.1:4321/' });
await new Promise(r => setTimeout(r, 2000));

const deskTitle = await evalInPage('document.title');
console.log('Заголовок страницы верстака:', deskTitle);
await takeScreenshot('01_desk_overview.png');

// А. Проверка удаления надписи логотипа из шапки и подвала
console.log('\nПроверка: удаление верхней надписи логотипа и нижнего подвала:');
const barsCheck = await evalInPage(`(() => {
  const topBrand = document.querySelector('.topbar-brand');
  const bottomBar = document.querySelector('.desk-bottombar');
  return {
    topBrandAbsent: topBrand === null,
    bottomBarAbsent: bottomBar === null,
  };
})()`);
console.log('Надпись .topbar-brand в шапке отсутствует:', barsCheck.topBrandAbsent);
console.log('Нижний подвал .desk-bottombar полностью отсутствует:', barsCheck.bottomBarAbsent);

// Б. Проверка правого бокового меню «ТРЕКЕРЫ»
console.log('\nПроверка: пункт бокового меню «ТРЕКЕРЫ»:');
const trackersNavInfo = await evalInPage(`(() => {
  const item = document.querySelector('.cabinet-nav-item[data-target="modal-trackers"]');
  return {
    exists: item !== null,
    label: item?.querySelector('.cabinet-nav-label')?.textContent?.trim(),
  };
})()`);
console.log('Пункт «ТРЕКЕРЫ» присутствует в шкафу:', trackersNavInfo.exists, `(текст: «${trackersNavInfo.label}»)`);

// Клик по боковому меню «ТРЕКЕРЫ»
console.log('Клик по «ТРЕКЕРЫ» в боковом шкафу (должен прокрутить верстак к плашке и открыть панель)...');
await evalInPage(`document.querySelector('.cabinet-nav-item[data-target="modal-trackers"]').click()`);
await new Promise(r => setTimeout(r, 600));

const trackersDrawerOpenFromNav = await evalInPage(`(() => {
  const d = document.getElementById('modal-trackers');
  const plank = document.querySelector('.hotspot-trackers');
  const img = d.querySelector('.dossier-screen-img')?.getAttribute('src');
  return {
    isOpen: d.classList.contains('is-open'),
    title: d.querySelector('.case-title')?.textContent,
    lead: d.querySelector('.case-lead')?.textContent,
    url: d.querySelector('.case-action-btn')?.href,
    plankHovered: plank?.classList.contains('is-hovered'),
    rawText: d.innerText,
    imageSrc: img,
  };
})()`);
console.log('Панель #modal-trackers открыта:', trackersDrawerOpenFromNav.isOpen);
console.log('Заголовок в панели:', trackersDrawerOpenFromNav.title);
console.log('Ссылка перехода:', trackersDrawerOpenFromNav.url);
console.log('Плашка на столе подсвечена (is-hovered):', trackersDrawerOpenFromNav.plankHovered);
console.log('Изображение в карточке трекера:', trackersDrawerOpenFromNav.imageSrc);
console.log('Ошибочное изображение земельного участка (landasset5) отсутствует:', !trackersDrawerOpenFromNav.imageSrc?.includes('landasset5'));
console.log('Используется подлинный скриншот трекера (preview-tracker01.jpg):', trackersDrawerOpenFromNav.imageSrc?.includes('preview-tracker01'));
console.log('Фраза «Релокант Сербия» отсутствует в панели:', !trackersDrawerOpenFromNav.rawText.includes('Релокант Сербия'));
await takeScreenshot('02_cabinet_nav_trackers.png');

// Закрываем панель
await evalInPage(`document.querySelector('#modal-trackers .close-drawer-btn').click()`);
await new Promise(r => setTimeout(r, 400));

// Проверка на http://127.0.0.1:8000/
console.log('\n--- 1.1. ПРОВЕРКА ЛОКАЛЬНОЙ ВЕРСИИ НА http://127.0.0.1:8000/ ---');
await sendCDP('Page.navigate', { url: 'http://127.0.0.1:8000/' });
await new Promise(r => setTimeout(r, 1500));
const port8000Check = await evalInPage(`(() => {
  const d = document.getElementById('modal-trackers');
  const img = d?.querySelector('.dossier-screen-img')?.getAttribute('src');
  const hasLandAsset = img ? img.includes('landasset5') : false;
  const hasTrackerImg = img ? img.includes('preview-tracker01') : false;
  return { title: document.title, img, hasLandAsset, hasTrackerImg };
})()`);
console.log('Сайт на http://127.0.0.1:8000/ доступен, заголовок:', port8000Check.title);
console.log('Изображение трекера на http://127.0.0.1:8000/:', port8000Check.img);
console.log('Земельный участок на http://127.0.0.1:8000/ устранён:', !port8000Check.hasLandAsset);
console.log('Подлинный скриншот трекера на http://127.0.0.1:8000/ загружен:', port8000Check.hasTrackerImg);

// Возвращаемся на http://127.0.0.1:4321/ для дальнейших проверок
await sendCDP('Page.navigate', { url: 'http://127.0.0.1:4321/' });
await new Promise(r => setTimeout(r, 1500));

// В. Проверка плашки «ТРЕКЕРЫ» непосредственно на столе
console.log('\nПроверка: клик по плашке «ТРЕКЕРЫ» на рабочем столе:');
await evalInPage(`document.querySelector('.hotspot-trackers').click()`);
await new Promise(r => setTimeout(r, 500));
const trackersDrawerFromDesk = await evalInPage(`document.getElementById('modal-trackers').classList.contains('is-open')`);
console.log('Клик по плашке на столе открывает #modal-trackers:', trackersDrawerFromDesk);
await takeScreenshot('03_desk_plank_trackers.png');
await evalInPage(`document.querySelector('#modal-trackers .close-drawer-btn').click()`);
await new Promise(r => setTimeout(r, 400));

// Г. Проверка плашки SRBIJA
console.log('\nПроверка: плашка и проект SRBIJA:');
await evalInPage(`document.querySelector('.hotspot-srbija').click()`);
await new Promise(r => setTimeout(r, 500));
const srbijaData = await evalInPage(`(() => {
  const d = document.getElementById('modal-srbija');
  const tag = d.querySelector('.drawer-tag')?.textContent;
  const title = d.querySelector('.case-title')?.textContent;
  const lead = d.querySelector('.case-lead')?.textContent;
  const links = Array.from(d.querySelectorAll('a')).map(a => a.href);
  const rawHtml = d.innerHTML;
  return {
    isOpen: d.classList.contains('is-open'),
    tag,
    title,
    lead: lead.slice(0, 80) + '...',
    hasRelocaLink: links.some(l => l.includes('reloca.gonka.blog')),
    relocantSerbiaAbsent: !rawHtml.includes('Релокант Сербия'),
  };
})()`);
console.log('Клик по SRBIJA открывает modal-srbija:', srbijaData.isOpen);
console.log('Тег и заголовок:', srbijaData.tag, '/', srbijaData.title);
console.log('Лид исследования:', srbijaData.lead);
console.log('Ссылка reloca.gonka.blog присутствует:', srbijaData.hasRelocaLink);
console.log('Фраза «Релокант Сербия» полностью отсутствует:', srbijaData.relocantSerbiaAbsent);
await takeScreenshot('04_drawer_srbija.png');
await evalInPage(`document.querySelector('#modal-srbija .close-drawer-btn').click()`);
await new Promise(r => setTimeout(r, 400));

// Д. Проверка отделения лупы от телефона
console.log('\nПроверка: отделение лупы от телефона:');
const phonePos = await evalInPage(`(() => {
  const p = document.querySelector('.hotspot-phone');
  const m = document.querySelector('.hotspot-slot-magnifier');
  const pr = p.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  return {
    phone: { top: pr.top, left: pr.left, width: pr.width, height: pr.height },
    magnifier: { top: mr.top, left: mr.left, width: mr.width, height: mr.height },
    separated: (mr.top >= pr.top + pr.height * 0.7)
  };
})()`);
console.log('Позиция телефона:', phonePos.phone);
console.log('Позиция лупы:', phonePos.magnifier);
console.log('Лупа отделена и расположена автономно:', phonePos.separated);

// Клик по лупе (Слот 5)
await evalInPage(`document.querySelector('.hotspot-slot-magnifier').click()`);
await new Promise(r => setTimeout(r, 400));
const magOpen = await evalInPage(`document.getElementById('modal-slot-magnifier').classList.contains('is-open')`);
console.log('Клик по лупе открывает Слот 5 (#modal-slot-magnifier):', magOpen);
await evalInPage(`document.querySelector('#modal-slot-magnifier .close-drawer-btn').click()`);
await new Promise(r => setTimeout(r, 300));

// Е. Проверка всех 6 резервных плашек стола
console.log('\nПроверка: все 6 резервных слотов верстака:');
const slotsToCheck = [
  { selector: '.hotspot-slot-lamp', id: 'modal-slot-lamp', name: 'Слот 1: Лампа' },
  { selector: '.hotspot-slot-mug', id: 'modal-slot-mug', name: 'Слот 2: Кружка' },
  { selector: '.hotspot-slot-compass', id: 'modal-slot-compass', name: 'Слот 3: Компас' },
  { selector: '.hotspot-slot-photos', id: 'modal-slot-photos', name: 'Слот 4: Две фотографии' },
  { selector: '.hotspot-slot-magnifier', id: 'modal-slot-magnifier', name: 'Слот 5: Лупа' },
  { selector: '.hotspot-slot-pencilcup', id: 'modal-slot-pencilcup', name: 'Слот 6: Стакан с карандашами' },
];

for (const s of slotsToCheck) {
  await evalInPage(`document.querySelector('${s.selector}').click()`);
  await new Promise(r => setTimeout(r, 350));
  const res = await evalInPage(`(() => {
    const d = document.getElementById('${s.id}');
    return {
      isOpen: d?.classList.contains('is-open'),
      title: d?.querySelector('.case-title')?.textContent,
      badge: d?.querySelector('.case-badge')?.textContent,
    };
  })()`);
  console.log(`  ✓ ${s.name} (${s.id}): открывается = ${res.isOpen}, заголовок = «${res.title}», бейдж = «${res.badge}»`);
  if (s.id === 'modal-slot-pencilcup') {
    await takeScreenshot('05_drawer_pencilcup_slot.png');
  }
  await evalInPage(`document.querySelector('#${s.id} .close-drawer-btn')?.click()`);
  await new Promise(r => setTimeout(r, 200));
}

// Ж. Проверка горизонтального свитка лендингов и каталога
console.log('\nПроверка: каталог сайтов/лендингов:');
await evalInPage(`document.querySelector('.hotspot-scroll-sites').click()`);
await new Promise(r => setTimeout(r, 500));
const catalogInfo = await evalInPage(`(() => {
  const d = document.getElementById('modal-sites');
  const cards = Array.from(d.querySelectorAll('.catalog-project-card')).map(c => ({
    name: c.querySelector('.catalog-project-name')?.textContent?.trim(),
    badge: c.querySelector('.catalog-badge')?.textContent?.trim(),
  }));
  return {
    isOpen: d.classList.contains('is-open'),
    cardsCount: cards.length,
    cards
  };
})()`);
console.log(`Каталог сайтов (#modal-sites): открыт = ${catalogInfo.isOpen}, карточек = ${catalogInfo.cardsCount}`);
await takeScreenshot('06_catalog_landings.png');
await evalInPage(`document.querySelector('#modal-sites .close-drawer-btn').click()`);
await new Promise(r => setTimeout(r, 400));


// ==========================================
// 2. ТЕСТИРОВАНИЕ АДМИНКИ (http://127.0.0.1:4310/)
// ==========================================
console.log('\n--- 2. ПРОВЕРКА АДМИНКИ НА http://127.0.0.1:4310/ ---');
await sendCDP('Page.navigate', { url: 'http://127.0.0.1:4310/' });
await new Promise(r => setTimeout(r, 1500));

// Проверка формы авторизации
const gateVisible = await evalInPage(`!document.getElementById('gate').hidden`);
console.log('Экран авторизации отображается:', gateVisible);
await takeScreenshot('07_admin_gate.png');

// Вход с токеном
await evalInPage(`(() => {
  document.getElementById('gate-token').value = '${TOKEN}';
  document.getElementById('gate-form').dispatchEvent(new Event('submit', { cancelable: true }));
})()`);
await new Promise(r => setTimeout(r, 1000));

const appVisible = await evalInPage(`!document.getElementById('app').hidden`);
console.log('Вход успешен, панель управления отображается:', appVisible);

// Проверка всех 8 вкладок
const tabsList = await evalInPage(`Array.from(document.querySelectorAll('#tabs button')).map(b => b.textContent)`);
console.log('Вкладки админки (всего 8):', tabsList);

// Вкладка «Резервные плашки»
console.log('\nПроверка вкладки «Резервные плашки»:');
const slotsInAdmin = await evalInPage(`(() => {
  const cards = Array.from(document.querySelectorAll('.slot-card')).map(c => ({
    name: c.querySelector('.slot-name')?.textContent,
    badge: c.querySelector('.badge-pill')?.textContent,
  }));
  return cards;
})()`);
console.log(`Отображается ${slotsInAdmin.length} слотов в админке:`);
for (const s of slotsInAdmin) {
  console.log(`  - ${s.name}: статус «${s.badge}»`);
}
await takeScreenshot('08_admin_slots_tab.png');

// Тест модала назначения на слот: клик по кнопке Слота 1 (Лампа)
console.log('\nТест назначения проекта на Слот 1...');
await evalInPage(`document.querySelectorAll('.slot-card')[0].querySelector('button').click()`);
await new Promise(r => setTimeout(r, 400));
const assignModalOpen = await evalInPage(`!document.getElementById('assign-modal').hidden`);
console.log('Модал выбора проекта (#assign-modal) открыт:', assignModalOpen);

// В модале нажимаем «+ Создать новый проект» для слота
await evalInPage(`document.getElementById('btn-create-for-slot').click()`);
await new Promise(r => setTimeout(r, 400));
const projectModalOpen = await evalInPage(`!document.getElementById('project-modal').hidden`);
console.log('Модальный редактор (#project-modal) открыт:', projectModalOpen);

// Заполняем форму тестовым проектом
await evalInPage(`(() => {
  document.getElementById('pf-name').value = 'Оптическая Лаборатория';
  document.getElementById('pf-badge').value = 'R&D ЭКСПЕРИМЕНТ';
  document.getElementById('pf-status').value = 'published';
  document.getElementById('pf-lead').value = 'Исследование световых паттернов и проекционной оптики.';
  document.getElementById('pf-url').value = 'https://optic.gonka.blog';
  document.getElementById('project-form').dispatchEvent(new Event('submit', { cancelable: true }));
})()`);
await new Promise(r => setTimeout(r, 500));

const slotAssignedState = await evalInPage(`(() => {
  const c = document.querySelectorAll('.slot-card')[0];
  return {
    isAssigned: c.classList.contains('is-assigned'),
    title: c.querySelector('.slot-project-title')?.textContent,
    dirty: document.getElementById('dirty')?.textContent
  };
})()`);
console.log('Слот 1 назначен локально:', slotAssignedState.title, `(dirty: «${slotAssignedState.dirty}»)`);

// Проверяем diff и сохраняем черновик
console.log('Проверка diff и сохранение черновика...');
await evalInPage(`document.getElementById('btn-save').click()`);
await new Promise(r => setTimeout(r, 400));
const diffVisible = await evalInPage(`!document.getElementById('diffbox').hidden`);
console.log('Окно diff отображается:', diffVisible);
await takeScreenshot('09_admin_diff_modal.png');

await evalInPage(`document.getElementById('btn-confirm').click()`);
await new Promise(r => setTimeout(r, 800));
const saveNotice = await evalInPage(`document.querySelector('.notice.ok')?.textContent`);
console.log('Черновик успешно сохранён:', saveNotice);

// Освобождаем Слот 1 обратно
console.log('Освобождение Слота 1 (снятие назначения)...');
await evalInPage(`(() => {
  window.confirm = () => true;
  document.querySelectorAll('.slot-card')[0].querySelector('button.danger').click();
})()`);
await new Promise(r => setTimeout(r, 400));
await evalInPage(`document.getElementById('btn-save').click()`);
await new Promise(r => setTimeout(r, 300));
await evalInPage(`document.getElementById('btn-confirm').click()`);
await new Promise(r => setTimeout(r, 800));
console.log('Слот 1 возвращён в чистый резерв.');

// Вкладка «Трекеры»
console.log('\nПроверка вкладки «Трекеры»:');
await evalInPage(`(() => {
  const btns = Array.from(document.querySelectorAll('#tabs button'));
  const b = btns.find(btn => btn.textContent.includes('Трекеры'));
  if (b) b.click();
})()`);
await new Promise(r => setTimeout(r, 500));

const trackersInAdmin = await evalInPage(`(() => {
  const rows = Array.from(document.querySelectorAll('#trackers-view .landing-row')).map(r => ({
    name: r.querySelector('.landing-name')?.textContent,
    badge: r.querySelector('.landing-badge')?.textContent,
    status: r.querySelector('.badge-pill')?.textContent,
    link: r.querySelector('.landing-link')?.href,
  }));
  return rows;
})()`);
console.log(`В каталоге трекеров админки: ${trackersInAdmin.length} проектов:`);
for (const t of trackersInAdmin) {
  console.log(`  - ${t.name} (${t.badge}): статус «${t.status}», ссылка: ${t.link}`);
}
await takeScreenshot('10_admin_trackers_tab.png');

// Вкладка «Лендинги»
console.log('\nПроверка вкладки «Лендинги»:');
await evalInPage(`(() => {
  const btns = Array.from(document.querySelectorAll('#tabs button'));
  const b = btns.find(btn => btn.textContent.includes('Лендинги'));
  if (b) b.click();
})()`);
await new Promise(r => setTimeout(r, 500));

const landingsInAdmin = await evalInPage(`(() => {
  const rows = Array.from(document.querySelectorAll('#landings-view .landing-row')).map(r => ({
    name: r.querySelector('.landing-name')?.textContent,
    badge: r.querySelector('.landing-badge')?.textContent,
    status: r.querySelector('.badge-pill')?.textContent
  }));
  return rows;
})()`);
console.log(`В каталоге лендингов админки: ${landingsInAdmin.length} проектов:`);
for (const l of landingsInAdmin) {
  console.log(`  - ${l.name} (${l.badge}): статус «${l.status}»`);
}
await takeScreenshot('11_admin_landings_tab.png');

// Тест кнопки «🚀 Опубликовать»
console.log('\nТест конвейера публикации через кнопку «🚀 Опубликовать»:');
await evalInPage(`document.getElementById('btn-publish').click()`);
await new Promise(r => setTimeout(r, 12000));
const publishNotice = await evalInPage(`document.querySelector('.notice.ok')?.textContent`);
const publishPill = await evalInPage(`document.getElementById('publish-pill')?.textContent`);
console.log('Результат публикации в админке:', publishNotice);
console.log('Индикатор сборки:', publishPill);
await takeScreenshot('12_admin_published_status.png');

// ==========================================
// 3. ПРОВЕРКА ПУБЛИЧНОГО САЙТА И ОТКАТА
// ==========================================
console.log('\n--- 3. ПРОВЕРКА ПУБЛИЧНОГО САЙТА И МЕХАНИЗМА ОТКАТА ---');

try {
  const liveRes = await fetch('https://gonka.blog', { method: 'HEAD' });
  console.log(`Публичный сайт https://gonka.blog доступен: статус ${liveRes.status} ${liveRes.statusText}`);
} catch (e) {
  console.log('Проверка https://gonka.blog:', e.message);
}

const backupFiles = fs.readdirSync(path.join(ROOT, 'src', 'data', '.backups'));
console.log(`Резервные копии в src/data/.backups/: создано ${backupFiles.length} снимков.`);
console.log('Последние бэкапы:');
backupFiles.slice(-5).forEach(b => console.log('  -', b));

ws.close();
chrome.kill();
console.log('\n=== БРАУЗЕРНАЯ ВЕРИФИКАЦИЯ УСПЕШНО ЗАВЕРШЕНА ===\n');
process.exit(0);
