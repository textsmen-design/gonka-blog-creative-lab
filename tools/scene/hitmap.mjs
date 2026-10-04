#!/usr/bin/env node
// tools/scene/hitmap.mjs — диагностика: какая зона получает наведение в каждой точке сцены.
// Рисует цветную карту поверх страницы и сохраняет PNG. Запуск:
//   BASE_URL=http://127.0.0.1:4351 node tools/scene/hitmap.mjs <папка-вывода> [ширина] [высота] [состояние: rest|bots|sites|author]
import { launch } from './cdp.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4351';
const [outDir = '.', w = '1440', h = '900', state = 'rest'] = process.argv.slice(2);
const b = await launch({ width: +w, height: +h, port: 9700 + Math.floor(Math.random() * 100) });
await b.goto(BASE + '/?theme=day', 500);
await b.waitFor(`document.getElementById('live-clock').textContent !== '--:--:--'`); await b.wait(1000);
if (state !== 'rest') {
  const sel = { bots: '.bots-closed-img', sites: '.sites-closed-img', author: '.scroll-closed-img' }[state];
  const r = JSON.parse(await b.eval(`JSON.stringify(document.querySelector('${sel}').getBoundingClientRect())`));
  await b.move(r.x + r.width * 0.55, r.y + r.height * 0.45); await b.wait(1200);
}
const STEP = 6;
const res = JSON.parse(await b.eval(`(() => {
  const cls = (e) => { if (!e) return 'none'; const o = e.closest('[data-obj]'); if (o) return 'obj:' + o.dataset.obj;
    for (const [c, n] of [['.hotspot-scroll-bots', 'scroll:bots'], ['.hotspot-scroll-sites', 'scroll:sites'], ['.hotspot-scroll', 'scroll:author'], ['.cabinet-menu-nav', 'menu'], ['.scene-hud', 'hud'], ['.desk-topbar', 'topbar']]) if (e.closest(c)) return n + (e.matches('.phone-interactive-hotspot') ? ':card' : '');
    return 'stage'; };
  const counts = {}; const cells = [];
  for (let y = 44; y < innerHeight; y += ${STEP}) for (let x = 0; x < innerWidth; x += ${STEP}) { const c = cls(document.elementFromPoint(x + 3, y + 3)); counts[c] = (counts[c] || 0) + 1; cells.push([x, y, c]); }
  return JSON.stringify({ counts, cells });
})()`));
const palette = ['#ff5252', '#40c4ff', '#ffd740', '#69f0ae', '#e040fb', '#ff9100', '#18ffff', '#b2ff59', '#ff4081', '#7c4dff', '#ffab40', '#64ffda', '#eeff41', '#ea80fc', '#ff6e40', '#84ffff'];
const names = [...new Set(res.cells.map((c) => c[2]))].filter((n) => n !== 'stage' && n !== 'none');
await b.eval(`(() => { const cv = document.createElement('canvas'); cv.width = innerWidth; cv.height = innerHeight; cv.style.cssText = 'position:fixed;inset:0;z-index:99999;pointer-events:none'; document.body.append(cv);
  const ctx = cv.getContext('2d'); const cells = ${JSON.stringify(res.cells.filter((c) => c[2] !== 'stage' && c[2] !== 'none'))}; const names = ${JSON.stringify(names)}; const pal = ${JSON.stringify(palette)};
  for (const [x, y, c] of cells) { ctx.globalAlpha = 0.5; ctx.fillStyle = pal[names.indexOf(c) % pal.length]; ctx.fillRect(x, y, ${STEP}, ${STEP}); }
  ctx.globalAlpha = 1; ctx.font = 'bold 12px monospace'; names.forEach((n, i) => { ctx.fillStyle = pal[i % pal.length]; ctx.fillRect(8, 50 + i * 16, 10, 10); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(n, 24, 59 + i * 16); ctx.fillText(n, 24, 59 + i * 16); }); })()`);
await b.move(1, 1);
await b.shot(`${outDir}/hitmap_${w}x${h}_${state}.png`);
const area = Object.fromEntries(Object.entries(res.counts).map(([k, v]) => [k, Math.round(v * STEP * STEP / 100) / 10 + ' кпикс']));
console.log(JSON.stringify(area, null, 1));
b.close();
