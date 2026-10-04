#!/usr/bin/env node
// tools/scene/test-scene.mjs — проверки интерактивной сцены: точность зон, карта, свитки, соседние предметы, переходы, клавиатура.
// Запуск: BASE_URL=http://127.0.0.1:4352 node tools/scene/test-scene.mjs   (адрес собранного сайта)
import fs from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4352';
const sceneCfg = JSON.parse(fs.readFileSync(new URL('../../src/data/scene.json', import.meta.url), 'utf8'));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const ready = (b) => b.waitFor(`document.getElementById('live-clock') && document.getElementById('live-clock').textContent !== '--:--:--'`);
const press = async (b, key, code, vk) => { await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text: key === 'Enter' ? '\r' : undefined }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); };
const op = (b, sel) => b.eval(`getComputedStyle(document.querySelector('${sel}')).opacity`).then(Number);

// Карта зон: что получает событие в каждой точке (шаг 4 px). Классы: obj:<id> | scroll:<имя>[:card|:spine] | stage | другое
const GRID = (step) => `(() => {
  const cls = (e) => { if (!e) return 'none'; const o = e.closest('[data-obj]'); if (o) return 'obj:' + o.dataset.obj;
    for (const [c, n] of [['.hotspot-scroll-bots', 'scroll:bots'], ['.hotspot-scroll-sites', 'scroll:sites'], ['.hotspot-scroll', 'scroll:author']]) if (e.closest(c)) return n + (e.matches('.phone-interactive-hotspot') ? ':card' : e.matches('.bots-spine') ? ':spine' : e.matches('.sites-screens-strip, .sites-screens-strip *') ? ':strip' : '');
    if (e.closest('.cabinet-menu-nav, .scene-hud, .desk-topbar, .workbench-drawer')) return 'ui';
    return 'stage'; };
  const out = {};
  for (let y = 46; y < innerHeight; y += ${step}) for (let x = 0; x < innerWidth; x += ${step}) { const c = cls(document.elementFromPoint(x, y)); (out[c] ||= []).push([x, y]); }
  return JSON.stringify(out);
})()`;
const rectOf = async (b, sel) => JSON.parse(await b.eval(`JSON.stringify((r => ({ x: r.x, y: r.y, w: r.width, h: r.height }))(document.querySelector('${sel}').getBoundingClientRect()))`));

for (const [w, h, port] of [[1440, 900, 9801], [1280, 720, 9802], [1920, 1080, 9803]].filter(([ww]) => !process.env.ONLY_W || String(ww) === process.env.ONLY_W)) {
  const T = `${w}×${h}`;
  const b = await launch({ width: w, height: h, port });
  await b.goto(BASE + '/?theme=day', 500); await ready(b); await b.wait(1000);
  const STEP = 4, cell = STEP * STEP;
  const g = JSON.parse(await b.eval(GRID(STEP)));
  const area = (k) => (g[k] || []).length * cell;

  // --- 1. карта SRBIJA кликабельна и занимает большую область ---
  check(`${T}: карта SRBIJA имеет большую область наведения/клика (≥ 50 000 px²)`, area('obj:map') >= 50000, `${area('obj:map')} px²`);
  const mp = (g['obj:map'] || []);
  if (mp.length) {
    const [mx, my] = mp[Math.floor(mp.length / 2)];
    await b.move(1, 60); await b.wait(150); await b.move(mx, my); await b.wait(500);
    check(`${T}: наведение на карту — подсветка (glow) и подпись SRBIJA`, (await op(b, '[data-obj="map"] .obj-lift')) === 1 && (await op(b, '[data-obj="map"] .obj-tip')) > 0.5);
    await b.eval(`document.elementFromPoint(${mx}, ${my}).click()`); await b.wait(400);
    check(`${T}: клик по карте открывает панель SRBIJA`, (await b.eval(`[...document.querySelectorAll('.workbench-drawer.is-open')].map(d => d.id).join()`)) === 'modal-srbija');
    await press(b, 'Escape', 'Escape', 27); await b.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await b.wait(300);
  }

  // --- 2. зоны свитков в покое: только силуэт закрытого свитка, никаких «невидимых» зон ---
  for (const [name, imgSel] of [['bots', '.bots-closed-img'], ['sites', '.sites-closed-img'], ['author', '.scroll-closed-img']]) {
    const r = await rectOf(b, imgSel);
    const own = Object.entries(g).filter(([k]) => k.startsWith('scroll:' + name)).flatMap(([, v]) => v);
    const outside = own.filter(([x, y]) => x < r.x - 2 || x > r.x + r.w + 2 || y < r.y - 2 || y > r.y + r.h + 2);
    const bbox = r.w * r.h;
    check(`${T}: свиток «${name}» в покое — нет зон вне изображения свитка`, outside.length === 0, `вне рамки: ${outside.length} точек`);
    check(`${T}: свиток «${name}» — зона наведения не больше его видимой рамки (${Math.round(own.length * cell)} из ${Math.round(bbox)} px²)`, own.length * cell <= bbox * 0.85 && own.length * cell > 0);
  }
  check(`${T}: в покое нет зон кнопок-карточек телефона`, area('scroll:bots:card') === 0 && area('scroll:bots:spine') === 0 && area('scroll:sites:strip') === 0);

  // --- 3. свитки: не раскрываются при приближении, раскрываются на самом свитке, закрываются при уходе ---
  const openSel = { bots: '.bots-unrolled-wrapper', sites: '.sites-unrolled-wrapper', author: '.scroll-unrolled-wrapper' };
  for (const name of ['bots', 'sites', 'author']) {
    const r = await rectOf(b, { bots: '.bots-closed-img', sites: '.sites-closed-img', author: '.scroll-closed-img' }[name]);
    const bad = [];
    // точки вокруг: 10/25/60 px от рамки свитка, и «прежняя зона карточек» на 80–140 px выше
    const probes = [[r.x - 10, r.y + r.h / 2], [r.x + r.w + 10, r.y + r.h / 2], [r.x + r.w / 2, r.y - 10], [r.x + r.w / 2, r.y + r.h + 10], [r.x - 25, r.y - 25], [r.x + r.w + 25, r.y + r.h + 25], [r.x + r.w / 2, r.y - 60], [r.x + r.w / 2, r.y - 110], [r.x + r.w / 2, r.y - 150]];
    for (const [px, py] of probes) {
      if (px < 2 || py < 46 || px > w - 2 || py > h - 2) continue;
      await b.move(1, 60); await b.wait(500); await b.move(px, py); await b.wait(650);
      if ((await op(b, openSel[name])) > 0.02) bad.push(`${Math.round(px - r.x)},${Math.round(py - r.y)}`);
    }
    check(`${T}: свиток «${name}» не раскрывается при курсоре рядом (в 10–150 px от изображения)`, bad.length === 0, bad.join(' '));
    await b.move(1, 60); await b.wait(600);
    await b.move(r.x + r.w * 0.55, r.y + r.h * 0.45); await b.wait(1000);
    await b.eval('document.getAnimations().forEach(a => a.finish())');
    const on = await op(b, openSel[name]);
    await b.move(1, 60); await b.wait(1000);
    await b.eval('document.getAnimations().forEach(a => a.finish())');
    check(`${T}: свиток «${name}» раскрывается на самом свитке (${on}) и закрывается после ухода (${await op(b, openSel[name])})`, on === 1 && (await op(b, openSel[name])) === 0);
  }

  // --- 4. при раскрытом свитке соседние предметы остаются доступными ---
  for (const name of ['bots', 'sites', 'author']) {
    const imgSel = { bots: '.bots-closed-img', sites: '.sites-closed-img', author: '.scroll-closed-img' }[name];
    const r = await rectOf(b, imgSel);
    await b.move(1, 60); await b.wait(500); await b.move(r.x + r.w * 0.55, r.y + r.h * 0.45); await b.wait(1000);
    const og = JSON.parse(await b.eval(GRID(STEP)));
    const blocked = Object.entries(og).filter(([k]) => k.startsWith('scroll:') && !k.endsWith(':card') && !k.endsWith(':spine') && !k.endsWith(':strip') && !k.startsWith('scroll:' + name + '') ).length;
    const ownOpen = Object.entries(og).filter(([k]) => k.startsWith('scroll:' + name)).flatMap(([k, v]) => v.map((p) => [k, ...p]));
    const interactive = ownOpen.filter(([k]) => /:(card|spine|strip)$/.test(k)).length * cell;
    const silhouette = ownOpen.filter(([k]) => !/:(card|spine|strip)$/.test(k)).length * cell;
    check(`${T}: раскрытый «${name}» перехватывает мышь только силуэтом и своими кнопками (кнопки ${Math.round(interactive)} px², силуэт ${Math.round(silhouette)} px²)`, interactive <= 40000 && silhouette <= (name === 'sites' ? 40000 : 20000)); // у «Лендинги» кликабелен и сам компактный пергамент (его содержимое)
    // потери площади соседних предметов не больше 40 % каждого
    const lossBad = [];
    for (const k of Object.keys(g).filter((k) => k.startsWith('obj:') && k !== 'obj:map')) {
      const before = g[k].length, after = (og[k] || []).length;
      if (before > 0 && after / before < 0.6) lossBad.push(`${k} ${Math.round(100 * after / before)}%`);
    }
    check(`${T}: раскрытый «${name}» не закрывает соседние предметы (каждый сохраняет ≥ 60 % зоны)`, lossBad.length === 0, lossBad.join(', '));
    // наведение на соседний предмет при раскрытом свитке: предмет оживает, свиток закрывается
    const neighbors = Object.keys(og).filter((k) => k.startsWith('obj:') && k !== 'obj:map' && og[k].length > 8);
    const noReach = [];
    for (const k of neighbors.slice(0, 40)) {
      const id = k.slice(4); const pts = og[k]; const [x, y] = pts[Math.floor(pts.length / 2)];
      await b.move(r.x + r.w * 0.55, r.y + r.h * 0.45); await b.wait(900);
      await b.move(x, y); await b.wait(500);
      // закрытие свитка идёт анимацией (до ~0.55 с); принудительно завершаем анимации
      await b.wait(500);
      await b.eval('document.getAnimations().forEach(a => a.finish())');
      const lifted = await op(b, `[data-obj="${id}"] .obj-lift`);
      const scrollOpen = await op(b, openSel[name]);
      if (lifted !== 1 || scrollOpen > 0.05) noReach.push(`${id}(lift ${lifted}, свиток ${scrollOpen})`);
    }
    check(`${T}: с раскрытым «${name}» можно навести на любой видимый предмет (${neighbors.length}) — он оживает, свиток закрывается`, noReach.length === 0, noReach.join(', '));
    await b.move(1, 60); await b.wait(500);
  }

  // --- 5. телефон «Боты»: путь от свитка к карточке не закрывает телефон, клик по карточке открывает досье ---
  {
    const r = await rectOf(b, '.bots-closed-img');
    await b.move(1, 60); await b.wait(500);
    const sx = r.x + r.w * 0.55, sy = r.y + r.h * 0.45;
    await b.move(sx, sy); await b.wait(900);
    const cards = JSON.parse(await b.eval(`JSON.stringify([...document.querySelectorAll('.phone-interactive-hotspot')].map(c => { const q = c.getBoundingClientRect(); return { id: c.dataset.openDrawer, x: q.x + q.width / 2, y: q.y + q.height / 2 }; }))`));
    let ok = true; const why = [];
    for (const c of cards) {
      // плавный путь из центра свитка к центру карточки
      await b.move(sx, sy); await b.wait(500);
      for (let i = 1; i <= 24; i++) { await b.move(sx + (c.x - sx) * i / 24, sy + (c.y - sy) * i / 24); await b.wait(30); }
      await b.wait(450);
      if ((await op(b, '.bots-unrolled-wrapper')) !== 1) { ok = false; why.push(`${c.id}: телефон закрылся по пути`); }
      const hit = await b.eval(`document.elementFromPoint(${c.x}, ${c.y}).closest('[data-open-drawer]')?.dataset.openDrawer`);
      if (hit !== c.id) { ok = false; why.push(`${c.id}: под курсором «${hit}»`); }
      await b.eval(`document.elementFromPoint(${c.x}, ${c.y}).click()`); await b.wait(350);
      const od = await b.eval(`[...document.querySelectorAll('.workbench-drawer.is-open')].map(d => d.id).join()`);
      if (od !== c.id) { ok = false; why.push(`${c.id}: открыто «${od}»`); }
      await b.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await b.wait(300);
      await b.move(1, 60); await b.wait(700);
    }
    check(`${T}: на телефоне «Боты» до обеих карточек можно дойти от свитка, клик открывает досье бота (${cards.map((c) => c.id).join(', ')})`, ok && cards.length >= 2);
  }

  // --- 6. клики по свиткам: правильные разделы; после клика свиток не «залипает» раскрытым ---
  for (const [name, imgSel, target] of [['bots', '.bots-closed-img', 'modal-bots'], ['sites', '.sites-closed-img', 'modal-sites'], ['author', '.scroll-closed-img', 'modal-about']]) {
    const r = await rectOf(b, imgSel);
    await b.move(1, 60); await b.wait(400);
    await b.move(r.x + r.w * 0.55, r.y + r.h * 0.45); await b.wait(900);
    // раскрытый пергамент «Лендинги» содержит чипы проектов: кликаем в точку, где под курсором не чип
    let cx = r.x + r.w * 0.55, cy = r.y + r.h * 0.45;
    if (name === 'sites') {
      const free = JSON.parse(await b.eval(`(() => { const pr = document.querySelector('.sites-unrolled-wrapper').getBoundingClientRect(); for (let y = pr.top + 4; y < pr.bottom - 4; y += 3) for (let x = pr.left + 4; x < pr.right - 4; x += 3) { const e = document.elementFromPoint(x, y); if (e && e.closest('.hotspot-scroll-sites') && !e.closest('[data-open-drawer]')) return JSON.stringify([x, y]); } return 'null'; })()`));
      if (free) { cx = free[0]; cy = free[1]; await b.move(cx, cy); await b.wait(300); }
    }
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 }); await b.wait(500);
    const opened = await b.eval(`[...document.querySelectorAll('.workbench-drawer.is-open')].map(d => d.id).join()`);
    await b.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await b.wait(300);
    await b.move(1, 60); await b.wait(1100);
    check(`${T}: клик по свитку «${name}» открывает ${target}; после закрытия и ухода курсора свиток закрыт`, opened === target && (await op(b, openSel[name])) === 0, `открыто «${opened}», opacity ${await op(b, openSel[name])}`);
  }

  // --- 7. каждый предмет: оживает внутри контура; соседние одновременно не оживают; подпись в экране ---
  const objs = Object.keys(g).filter((k) => k.startsWith('obj:') && g[k].length > 12);
  let multi = [], notLit = [], tipBad = [];
  for (const k of objs) {
    const id = k.slice(4);
    // «ядро» зоны: точка, вокруг которой ±6 px принадлежат этому же предмету
    const set = new Set(g[k].map((p) => p.join(',')));
    const core = g[k].filter(([x, y]) => [[8, 0], [-8, 0], [0, 8], [0, -8]].every(([dx, dy]) => set.has(`${x + dx},${y + dy}`)));
    if (!core.length) continue;
    const [x, y] = core[Math.floor(core.length / 2)];
    await b.move(1, 60); await b.wait(150); await b.move(x, y); await b.wait(500);
    const lifts = JSON.parse(await b.eval(`JSON.stringify([...document.querySelectorAll('.scene-obj')].filter(o => getComputedStyle(o.querySelector('.obj-lift')).opacity === '1').map(o => o.dataset.obj))`));
    if (!lifts.includes(id)) notLit.push(id);
    if (lifts.length > 1) multi.push(`${id}+${lifts.filter((l) => l !== id).join('+')}`);
    const tip = JSON.parse(await b.eval(`(() => { const t = document.querySelector('[data-obj="${id}"] .obj-tip'); if (!t) return 'null'; const r = t.getBoundingClientRect(); return JSON.stringify({ l: r.left, r: r.right, t: r.top, op: getComputedStyle(t).opacity }); })()`));
    if (tip && Number(tip.op) > 0.5 && (tip.l < 0 || tip.r > w || tip.t < 42)) tipBad.push(id);
  }
  check(`${T}: каждый предмет (${objs.length}) оживает при наведении внутри контура`, notLit.length === 0, notLit.join(', '));
  check(`${T}: при наведении на предмет оживает только он (соседи не срабатывают)`, multi.length === 0, multi.join(', '));
  check(`${T}: подписи предметов не выходят за экран`, tipBad.length === 0, tipBad.join(', '));

  // --- 8. вне контура предмет не оживает (угол рамки) ---
  let leak = [];
  for (const k of objs) {
    const id = k.slice(4);
    const r = await rectOf(b, `[data-obj="${id}"]`);
    let found = null;
    for (let yy = r.y; yy < r.y + r.h && !found; yy += 5) for (let xx = r.x; xx < r.x + r.w; xx += 5) {
      if (xx < 2 || yy < 46 || xx > w - 2 || yy > h - 2) continue;
      if (!g[k].some(([x, y]) => Math.abs(x - xx) < 6 && Math.abs(y - yy) < 6) && !Object.values(g).some((v, i) => false)) { found = [xx, yy]; break; }
    }
    if (!found) continue;
    const owner = Object.entries(g).find(([kk, v]) => kk !== k && v.some(([x, y]) => Math.abs(x - found[0]) < 3 && Math.abs(y - found[1]) < 3));
    if (owner && owner[0].startsWith('obj:')) continue; // точка принадлежит другому предмету — проверяется отдельно
    await b.move(1, 60); await b.wait(150); await b.move(found[0], found[1]); await b.wait(700);
    if ((await op(b, `[data-obj="${id}"] .obj-lift`)) > 0) leak.push(id);
  }
  check(`${T}: вне контура предмет не оживает`, leak.length === 0, leak.join(', '));
  check(`${T}: нет JS-ошибок`, b.jsErrors().length === 0, b.jsErrors().join('; '));

  if (w === 1440) {
    // --- 9. назначение предметов и переходы ---
    const wrong = [];
    for (const it of sceneCfg.items) {
      const pts = g['obj:' + it.id]; if (!pts || !pts.length) continue;
      await b.eval(`document.querySelector('[data-obj="${it.id}"] .obj-hit').click()`); await b.wait(250);
      const open = await b.eval(`[...document.querySelectorAll('.workbench-drawer.is-open')].map(d => d.id).join(',')`);
      if (open !== it.target) wrong.push(`${it.id}: ждали ${it.target}, открыто «${open}»`);
      await b.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`); await b.wait(150);
    }
    check('каждый предмет открывает назначенную панель', wrong.length === 0, wrong.join('; '));
    check('все назначенные панели существуют', (await b.eval(`JSON.stringify(${JSON.stringify([...new Set(sceneCfg.items.map((x) => x.target))])}.filter(t => !document.getElementById(t)))`)) === '[]');
    const sc = JSON.parse(await b.eval(`JSON.stringify({ bots: document.querySelector('.hotspot-scroll-bots').dataset.target, sites: document.querySelector('.hotspot-scroll-sites').dataset.target, author: document.querySelector('.hotspot-scroll').dataset.target })`));
    check('свитки ведут: Боты → modal-bots, Лендинги → modal-sites, Автор → modal-about', sc.bots === 'modal-bots' && sc.sites === 'modal-sites' && sc.author === 'modal-about', JSON.stringify(sc));
    // --- 10. клавиатура ---
    await b.move(1, 60);
    for (let i = 0; i < 40; i++) { await press(b, 'Tab', 'Tab', 9); if (await b.eval(`document.activeElement.classList.contains('obj-hit')`)) break; }
    check('клавиатура: Tab фокусирует предмет с доступной подписью', !!(await b.eval(`document.activeElement.getAttribute('aria-label')`)));
    await press(b, 'Enter', 'Enter', 13); await b.wait(500);
    check('клавиатура: Enter открывает панель', (await b.eval(`document.querySelectorAll('.workbench-drawer.is-open').length`)) === 1);
  }
  b.close();
}

console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
