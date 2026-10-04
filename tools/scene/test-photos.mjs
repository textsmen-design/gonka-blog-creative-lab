#!/usr/bin/env node
// tools/scene/test-photos.mjs — фото автора (панель «Автор») и фото Белграда (панель SRBIJA, сцена): файлы, вёрстка в обоих режимах, сцена.
// Запуск: BASE_URL=http://127.0.0.1:4354 node tools/scene/test-photos.mjs
import fs from 'node:fs';
import { launch } from './cdp.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4354';
const ROOT = new URL('../../', import.meta.url);
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const media = JSON.parse(fs.readFileSync(new URL('src/data/media.json', ROOT), 'utf8')).previews;

// 1. Файлы и данные
for (const [key, ratio] of [['authorPortrait', 0.75], ['srbijaBelgrade', 16 / 9]]) {
  const rel = media[key]; const p = new URL('public' + rel, ROOT);
  const ok = !!rel && fs.existsSync(p);
  check(`media.json: ${key} → файл существует`, ok, rel);
  if (ok) {
    const size = fs.statSync(p).size;
    check(`${key}: размер ≤ 2 МБ (${Math.round(size / 1024)} КБ), формат JPEG/PNG/WebP`, size <= 2 * 1024 * 1024 && /\.(jpg|png|webp)$/.test(rel));
    const buf = fs.readFileSync(p); let w = 0, h = 0;                                // JPEG: ищем SOF0/SOF2
    for (let i = 2; i < buf.length - 9; i++) if (buf[i] === 0xff && (buf[i + 1] === 0xc0 || buf[i + 1] === 0xc2)) { h = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break; }
    check(`${key}: пропорции исходного файла ${w}×${h} = ожидаемые`, Math.abs(w / h - ratio) < 0.01, (w / h).toFixed(3));
  }
}
check('исходные фото в корне проекта не изменены и не продублированы в public/', ['avtor.png', 'avor-panel.png', 'srbia.png'].every((f) => fs.existsSync(new URL(f, ROOT))) && !fs.existsSync(new URL('public/avtor.png', ROOT)) && !fs.existsSync(new URL('public/srbia.png', ROOT)));

// 1b. author-wide.jpg — тот же кадр, что и avtor.png (не другое изображение)
{
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('python3', ['-c', `
from PIL import Image, ImageChops
a=Image.open('${new URL('avtor.png', ROOT).pathname}').convert('RGB'); b=Image.open('${new URL('public/previews/author-wide.jpg', ROOT).pathname}').convert('RGB')
print(a.size==b.size, sum(ImageChops.difference(a.resize((256,170)),b.resize((256,170))).convert('L').getdata())/(256*170))
`]).toString().trim().split(' ');
  check('author-wide.jpg = avtor.png (тот же размер 1536×1024, среднее отличие < 3/255)', out[0] === 'True' && parseFloat(out[1]) < 3, out.join(' / '));
}

// 2. Сцена: изменена только область фотографии на столе
{
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('python3', ['-c', `
from PIL import Image, ImageChops
for name in ('day','night'):
    a=Image.open('${new URL('legacy/scene-pre-photos/', ROOT).pathname}'+name+'.jpg').convert('RGB'); b=Image.open('${new URL('public/scene/', ROOT).pathname}'+name+'.jpg').convert('RGB')
    d=ImageChops.difference(a,b).convert('L').point(lambda v:255 if v>40 else 0)
    print(name, a.size==b.size, d.getbbox())
`]).toString().trim().split('\n').map((l) => l.split(' '));
  for (const [name, same, ...bb] of out) {
    const box = JSON.parse(bb.join(' ').replace(/\(/g, '[').replace(/\)/g, ']'));
    check(`сцена ${name}.jpg: размер прежний; изменена только область фото на столе ${JSON.stringify(box)}`, same === 'True' && box && box[0] >= 990 && box[1] >= 660 && box[2] <= 1295 && box[3] <= 820);
  }
}

// 3. Вёрстка панелей в обоих режимах
const rect = (b, sel) => b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'null'; const r = e.getBoundingClientRect(); return JSON.stringify({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }); })()`).then(JSON.parse);
const inter = (a, b) => !(a.r <= b.l + 1 || b.r <= a.l + 1 || a.b <= b.t + 1 || b.b <= a.t + 1);

for (const [w, h, port, label] of [[1440, 900, 9881, 'десктоп 1440'], [1280, 720, 9882, 'ноутбук 1280'], [390, 844, 9883, 'телефон 390']]) {
  if (process.env.ONLY_W && Number(process.env.ONLY_W) !== w) continue;
  const b = await launch({ width: w, height: h, port, mobile: w < 500 });
  for (const [drawer, figSel, cases] of [['modal-about', '.author-portrait', [['свёрнуто', false], ['на весь стол', true]]], ['modal-srbija', '.srbija-photo', [['свёрнуто', false], ['на весь стол', true]]]]) {
    for (const [mode, expand] of cases) {
      const sel = (drawer === 'modal-about' && expand) ? '.author-wide' : figSel;   // в развёрнутой записи автора — кадр avtor.png целиком
      await b.goto(`${BASE}/?theme=day&open=${drawer}`, 600);
      await b.waitFor(`document.getElementById('${drawer}')?.classList.contains('is-open')`); await b.wait(900);
      if (expand) { await b.eval(`document.querySelector('#${drawer} .expand-drawer-btn').click()`); await b.wait(900); }
      await b.eval(`document.querySelector('#${drawer} ${sel} img').loading = 'eager'`);
      await b.waitFor(`(() => { const i = document.querySelector('#${drawer} ${sel} img'); return i && i.complete && i.naturalWidth > 0; })()`, 8000);
      await b.wait(400);
      await b.waitFor(`document.getElementById('${drawer}').getBoundingClientRect().left < ${w < 500 ? 3 : 'innerWidth - 100'}`, 2500);
      await b.eval(`document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} })`); await b.wait(150);   // headless не всегда отдаёт кадры — доводим переход панели до конца   // панель выехала полностью
      const T = `${label}, ${drawer === 'modal-about' ? 'Автор' : 'SRBIJA'}, ${mode}`;
      const img = JSON.parse(await b.eval(`(() => { const i = document.querySelector('#${drawer} ${sel} img'); const f = i.parentElement; const r = i.getBoundingClientRect(); return JSON.stringify({ nw: i.naturalWidth, nh: i.naturalHeight, w: r.width, h: r.height, fw: f.clientWidth, fh: f.clientHeight, fit: getComputedStyle(i).objectFit }); })()`));
      check(`${T}: изображение загружено`, img.nw > 0, `${img.nw}×${img.nh}`);
      check(`${T}: без искажений (object-fit: cover, рамка = кадр)`, img.fit === 'cover' && Math.abs(img.w - img.fw) < 1.5 && Math.abs(img.h - img.fh) < 1.5, `${Math.round(img.w)}×${Math.round(img.h)}`);
      if (drawer === 'modal-about' && !expand) check(`${T}: портрет сохраняет пропорции 3:4`, Math.abs(img.fw / img.fh - 0.75) < 0.03, (img.fw / img.fh).toFixed(3));
      if (drawer === 'modal-about' && expand) {
        const info = JSON.parse(await b.eval(`JSON.stringify({ src: document.querySelector('#modal-about .author-wide img').currentSrc, ratio: document.querySelector('#modal-about .author-wide img').naturalWidth / document.querySelector('#modal-about .author-wide img').naturalHeight, portraitShown: getComputedStyle(document.querySelector('#modal-about .author-portrait')).display !== 'none' })`));
        check(`${T}: показан кадр avtor.png целиком (author-wide.jpg ${info.ratio.toFixed(3)}), боковой портрет скрыт`, /author-wide\.jpg$/.test(info.src) && Math.abs(info.ratio - 1.5) < 0.005 && !info.portraitShown);
        check(`${T}: естественные пропорции 3:2 без растягивания и обрезки`, Math.abs(img.fw / img.fh - 1.5) < 0.03, (img.fw / img.fh).toFixed(3));
        const text = await rect(b, '#modal-about .author-hero-text');
        const fig2 = await rect(b, '#modal-about .author-wide');
        if (w >= 900) check(`${T}: фото справа от заголовка, описания и кнопок (рядом, не под ними)`, fig2.l >= text.r - 1 && Math.abs((fig2.t + fig2.b) / 2 - (text.t + text.b) / 2) < 120, `фото ${Math.round(fig2.l)}..${Math.round(fig2.r)}, текст ..${Math.round(text.r)}`);
        else check(`${T}: на узком экране фото над текстом, во всю ширину`, fig2.b <= text.t + 2 && fig2.w > ((await rect(b, '#modal-about')).w) * 0.7, `ширина ${Math.round(fig2.w)}`);
        const hero = await rect(b, '#modal-about .case-hero-strip');
        if (w >= 900) check(`${T}: верхний блок компактный (высота ${Math.round(hero.h)} px ≤ 330, нет лишней пустоты)`, hero.h <= 330);
      }
      const fig = await rect(b, `#${drawer} ${sel}`);
      const dr = await rect(b, `#${drawer}`);
      check(`${T}: фото целиком внутри панели и экрана`, fig.l >= dr.l - 1 && fig.r <= dr.r + 1 && fig.r <= w + 1 && fig.l >= -1, `${Math.round(fig.l)}..${Math.round(fig.r)} из ${Math.round(dr.l)}..${Math.round(dr.r)}`);
      // не перекрывает текст и элементы управления
      const others = await b.eval(`JSON.stringify([...document.querySelectorAll('#${drawer} .drawer-header *, #${drawer} .status-live, #${drawer} .case-title, #${drawer} .case-lead, #${drawer} .case-action-btn, #${drawer} .section-heading')].filter(e => e.getBoundingClientRect().width > 0 && !e.closest(${JSON.stringify(sel)})).map(e => { const r = e.getBoundingClientRect(); return { n: (e.className || e.tagName).toString().slice(0, 30), l: r.left, t: r.top, r: r.right, b: r.bottom }; }))`).then(JSON.parse);
      const hit = others.filter((o) => inter(fig, o));
      check(`${T}: не перекрывает текст и кнопки (${others.length} элементов проверено)`, hit.length === 0, hit.map((o) => o.n).join(', '));
      const hscroll = await b.eval(`document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.getElementById('${drawer}').scrollWidth <= document.getElementById('${drawer}').clientWidth + 1`);
      check(`${T}: нет горизонтальной прокрутки`, hscroll);
      if (port === 9881 && drawer === 'modal-about' && !expand) await b.shot('/tmp/gonka-photo-about-collapsed.png');
      if (port === 9881 && drawer === 'modal-about' && expand) await b.shot('/tmp/gonka-photo-about-expanded.png');
      if (port === 9881 && drawer === 'modal-srbija' && !expand) await b.shot('/tmp/gonka-photo-srbija-collapsed.png');
      if (port === 9883 && drawer === 'modal-about' && !expand) await b.shot('/tmp/gonka-photo-about-mobile.png');
    }
  }
  check(`${label}: нет JS-ошибок`, b.jsErrors().length === 0, b.jsErrors().join('; '));
  b.close();
}

// 4. Кнопки управления панелью «Автор» работают (закрыть/развернуть/свернуть)
{
  const b = await launch({ width: 1440, height: 900, port: 9884 });
  await b.goto(`${BASE}/?theme=day&open=modal-about`, 800);
  await b.eval(`document.querySelector('#modal-about .expand-drawer-btn').click()`); await b.wait(700);
  const expanded = await b.eval(`document.getElementById('modal-about').classList.contains('is-expanded')`);
  await b.eval(`document.querySelector('#modal-about .expand-drawer-btn').click()`); await b.wait(700);
  const back = !(await b.eval(`document.getElementById('modal-about').classList.contains('is-expanded')`));
  await b.eval(`document.querySelector('#modal-about .close-drawer-btn').click()`); await b.wait(500);
  const closed = !(await b.eval(`document.getElementById('modal-about').classList.contains('is-open')`));
  check('панель «Автор»: развернуть → свернуть → закрыть работают при наличии фото', expanded && back && closed);
  b.close();
}
console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
