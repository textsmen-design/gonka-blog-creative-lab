#!/usr/bin/env node
// tools/scene/test-mailto.mjs — все ссылки электронной почты: формат mailto:, совпадение с links.json, клик не блокируется,
// браузер передаёт запрос ОС (событие навигации на mailto:). Открытие почтового приложения зависит от ОС и сюда не входит.
// Запуск: BASE_URL=http://127.0.0.1:4363 node tools/scene/test-mailto.mjs
import fs from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4363';
const links = JSON.parse(fs.readFileSync(new URL('../../src/data/links.json', import.meta.url), 'utf8'));
const EMAIL = links.socials.find((s) => s.id === 'email').url;        // единый источник: links.socials[email]
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

check('links.json: адрес в формате mailto:имя@домен.зона', /^mailto:[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(EMAIL), EMAIL);
const html = await (await fetch(BASE + '/')).text();
const hrefs = [...html.matchAll(/href="(mailto:[^"]*)"/g)].map((m) => m[1]);
check(`в собранной странице ${hrefs.length} ссылок mailto, все = ${EMAIL}`, hrefs.length >= 5 && hrefs.every((h) => h === EMAIL), [...new Set(hrefs)].join(', '));
check('нет mailto с лишними параметрами/пробелами/кодированием и нет «голых» адресов-ссылок без mailto:', hrefs.every((h) => !/[%\s?&]/.test(h)) && !/href="[^"\/:?]+@[^"\/:?]+\.[A-Za-z]{2,}"/.test(html));
check('в проекте нет адреса с опечаткой textman@', !html.includes('textman@'));

const b = await launch({ width: 1440, height: 900, port: 9941 });
const cases = [
  ['шапка сцены: иконка конверта (день)', '/?theme=day', null, '.scene-social a[href^="mailto:"]'],
  ['шапка сцены: иконка конверта (ночь)', '/?theme=night', null, '.scene-social a[href^="mailto:"]'],
  ['«Автор», свёрнуто: кнопка «Отправить email»', '/?theme=day&open=modal-about', null, '#modal-about .case-action-btn[href^="mailto:"]'],
  ['«Автор», свёрнуто: строка «Email:»', '/?theme=day&open=modal-about', null, '#modal-about .mail-link'],
  ['«Автор», на весь стол: кнопка «Отправить email»', '/?theme=day&open=modal-about', `document.querySelector('#modal-about .expand-drawer-btn').click()`, '#modal-about .case-action-btn[href^="mailto:"]'],
  ['«Автор», на весь стол: строка «Email:»', '/?theme=day&open=modal-about', `document.querySelector('#modal-about .expand-drawer-btn').click()`, '#modal-about .mail-link'],
  ['«Входящий» (связь): кнопка email', '/?theme=day&open=modal-incoming', null, '#modal-incoming .case-action-btn[href^="mailto:"]'],
  ['«Входящий» (связь), на весь стол: кнопка email', '/?theme=day&open=modal-incoming', `document.querySelector('#modal-incoming .expand-drawer-btn').click()`, '#modal-incoming .case-action-btn[href^="mailto:"]'],
  ['«Входящий» (связь): строка «Email:»', '/?theme=day&open=modal-incoming', null, '#modal-incoming .mail-link'],
];
for (const [label, url, prep, sel] of cases) {
  for (const method of ['мышь', 'клавиатура']) {
    await b.goto(BASE + url, 500);
    await b.waitFor(`document.getElementById('live-clock').textContent !== '--:--:--'`); await b.wait(900);
    if (prep) { await b.eval(prep); await b.wait(1100); }
    await b.eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`); await b.wait(500);
    const r = JSON.parse(await b.eval(`(() => { const a = document.querySelector(${JSON.stringify(sel)}); if (!a) return JSON.stringify({ found: false });
      const q = a.getBoundingClientRect(); const x = q.x + q.width / 2, y = q.y + q.height / 2; const top = document.elementFromPoint(x, y);
      window.__dp = null; window.addEventListener('click', (e) => { window.__dp = e.defaultPrevented; }, { once: true });
      return JSON.stringify({ found: true, href: a.getAttribute('href'), x, y, topIsLink: !!top && (top === a || a.contains(top)), onScreen: x > 0 && y > 0 && x < innerWidth && y < innerHeight }); })()`));
    if (!r.found) { check(`${label} [${method}]: ссылка найдена`, false); continue; }
    b.events.length = 0;
    if (method === 'мышь') {
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    } else {
      await b.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`);
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
    const navSeen = () => b.events.some((e) => JSON.stringify(e).includes('mailto:textsmen')) && b.events.some((e) => e.method === 'Page.frameRequestedNavigation');
    for (let k = 0; k < 20 && !navSeen(); k++) await b.wait(150);   // событие навигации в headless приходит с задержкой
    const dp = await b.eval('window.__dp');
    const nav = navSeen();
    const stayed = (await b.eval('location.href')).startsWith(BASE);
    check(`${label} [${method}]: href = ${EMAIL}; клик не отменён; браузер запросил mailto:`, r.href === EMAIL && dp !== true && nav && stayed && (method === 'клавиатура' || (r.topIsLink && r.onScreen)),
      `href=${r.href} defaultPrevented=${dp} навигация=${nav} ссылка сверху=${r.topIsLink}`);
  }
}
check('нет JS-ошибок', b.jsErrors().length === 0, b.jsErrors().join('; '));
b.close();
console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
