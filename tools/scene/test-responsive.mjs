#!/usr/bin/env node
// tools/scene/test-responsive.mjs — адаптивность: страница без горизонтальной прокрутки; все панели (свёрнуто и «на весь стол») не выходят
// за свои границы на разных ширинах; меню и кнопки доступны; нет JS-ошибок. Запуск: BASE_URL=http://127.0.0.1:4321 node tools/scene/test-responsive.mjs
import { launch } from './cdp.mjs';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4321';
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const SIZES = [[360, 740], [390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];
let port = 9970;
for (const [w, h] of SIZES.filter(([ww]) => !process.env.ONLY_W || String(ww) === process.env.ONLY_W)) {
  const b = await launch({ width: w, height: h, port: port++, mobile: w < 600 });
  await b.goto(BASE + '/?theme=day', 500);
  await b.waitFor(`document.getElementById('live-clock')?.textContent !== '--:--:--'`); await b.wait(900);
  const page = await b.eval(`JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, nav: [...document.querySelectorAll('.cabinet-nav-item')].every(e => { const r = e.getBoundingClientRect(); return r.width > 20 && r.left >= -1 && r.right <= innerWidth + 1; }), toggle: (() => { const r = document.getElementById('desk-theme-toggle').getBoundingClientRect(); return r.right <= innerWidth + 1 && r.width > 20; })() })`);
  const P = JSON.parse(page);
  check(`${w}×${h}: страница без горизонтальной прокрутки`, P.sw <= P.cw, `${P.sw}/${P.cw}`);
  check(`${w}×${h}: меню разделов и переключатель день/ночь целиком на экране`, P.nav && P.toggle);
  const ids = JSON.parse(await b.eval(`JSON.stringify([...document.querySelectorAll('.workbench-drawer')].map(d => d.id))`));
  const bad = [];
  for (const id of ids) {
    for (const expand of [false, true]) {
      await b.eval(`document.dispatchEvent(new CustomEvent('gonka:open', { detail: { target: '${id}' } }))`); await b.wait(700);
      if (expand) { await b.eval(`document.querySelector('#${id} .expand-drawer-btn')?.click()`); await b.wait(700); }
      await b.waitFor(`document.getElementById('${id}').getBoundingClientRect().left < innerWidth - 40 && getComputedStyle(document.getElementById('${id}')).visibility === 'visible'`, 4000);   // панель выехала (headless рисует кадры с задержкой)
      await b.wait(500);
      const m = JSON.parse(await b.eval(`(() => { const d = document.getElementById('${id}'); const dr = d.getBoundingClientRect(); const over = []; d.querySelectorAll('.case-body *, .drawer-header *').forEach(e => { const r = e.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && (r.right > dr.right + 2 || r.left < dr.left - 2) && getComputedStyle(e).position !== 'fixed' && !e.closest('.sites-screens-strip, .film-strip, [class*="scroll"]')) over.push((e.className || e.tagName).toString().slice(0, 28)); }); return JSON.stringify({ open: d.classList.contains('is-open'), left: dr.left, right: dr.right, over: [...new Set(over)].slice(0, 4), hs: d.scrollWidth > d.clientWidth + 2, closeVisible: (() => { const c = d.querySelector('.close-drawer-btn').getBoundingClientRect(); return c.right <= innerWidth + 1 && c.width > 0; })() }); })()`));
      if (!m.open || m.hs || m.over.length || !m.closeVisible || m.right > w + 2) bad.push(`${id}${expand ? '/на весь стол' : ''}: ${m.hs ? 'прокрутка по X ' : ''}${m.over.length ? 'выход: ' + m.over.join(',') + ' ' : ''}${m.closeVisible ? '' : 'кнопка «закрыть» вне экрана '}${m.open ? '' : 'не открылась'}`);
      await b.eval(`document.querySelector('#${id} .close-drawer-btn')?.click()`); await b.wait(300);
    }
  }
  check(`${w}×${h}: все ${ids.length} панелей (свёрнуто и на весь стол) в границах экрана, «закрыть» доступна`, bad.length === 0, bad.slice(0, 4).join(' | '));
  check(`${w}×${h}: нет JS-ошибок`, b.jsErrors().length === 0, b.jsErrors().join('; '));
  b.close();
}
console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
