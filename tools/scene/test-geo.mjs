#!/usr/bin/env node
// tools/scene/test-geo.mjs — изолированные проверки геолокации, времени и часового пояса верхней панели.
// Запуск: BASE_URL=http://127.0.0.1:4341 node tools/scene/test-geo.mjs
// Координаты синтетические (10.5 / -20.25). Реальный GPS не используется: Emulation.setGeolocationOverride + заглушки API.
import { launch } from './cdp.mjs';
import { formatCoords, tzLabel, stateFromError, AUTHOR_POINT, GEO_STATES, GEO_TEXT } from '../../src/scene/geo.mjs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:4341';
const ORIGIN = new URL(BASE).origin;
const FAKE = { latitude: 10.5, longitude: -20.25, accuracy: 25 };
const AUTHOR = '45°15′N 19°51′E';
let pass = 0, fail = 0, port = 9600;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const panel = (b) => b.eval(`JSON.stringify({ state: document.getElementById('live-geo').dataset.state, coords: document.getElementById('live-coords').textContent, mode: document.getElementById('live-coords').dataset.source, src: document.getElementById('live-coords-src').textContent, btn: document.getElementById('geo-btn').textContent, btnHidden: document.getElementById('geo-btn').hidden, btnDisabled: document.getElementById('geo-btn').disabled, hint: document.getElementById('geo-hint').textContent, clock: document.getElementById('live-clock').textContent, tz: document.getElementById('live-tz').textContent })`).then(JSON.parse);
const init = (b) => b.waitFor(`document.getElementById('live-clock').textContent !== '--:--:--'`);
const COUNT = `window.__geo = { get: 0, watch: 0, opts: null };`;
const perm = (b, setting) => b.browserSend('Browser.setPermission', { permission: { name: 'geolocation' }, setting, origin: ORIGIN });
async function open(opts, { permission = 'prompt', pre = '', override = false } = {}) {
  const b = await launch({ port: port++, ...opts });
  await perm(b, permission);
  if (override) await b.send('Emulation.setGeolocationOverride', FAKE);
  await b.beforeLoad(COUNT + pre);
  await b.goto(BASE, 400); await init(b); await b.wait(1500);
  return b;
}
const click = (b) => b.eval(`document.getElementById('geo-btn').click()`);
const calls = (b) => b.eval('JSON.stringify(window.__geo)').then(JSON.parse);
const stubOf = (body) => `navigator.geolocation.getCurrentPosition = (ok, err, opts) => { window.__geo.get++; window.__geo.opts = opts; ${body} };`;

// 0. Чистые функции и словари состояний
check('форматирование: авторская точка', formatCoords(AUTHOR_POINT.lat, AUTHOR_POINT.lon) === AUTHOR);
check('форматирование: полушария и округление минут', formatCoords(-33.8688, -151.2093) === '33°52′S 151°13′W' && formatCoords(59.99999, 179.99999) === '60°00′N 180°00′E');
check('форматирование: мусор → null', [formatCoords(91, 0), formatCoords(NaN, 1), formatCoords('1', 2), formatCoords(0, 181)].every((v) => v === null));
check('stateFromError: 1→denied, 2→unavailable, 3→timeout, прочее→error', [1, 2, 3, 9].map((c) => stateFromError({ code: c })).join() === 'denied,unavailable,timeout,error' && stateFromError(null) === 'error');
check('для каждого состояния есть тексты (источник, кнопка, подсказка)', GEO_STATES.every((s) => GEO_TEXT[s] && GEO_TEXT[s].src && GEO_TEXT[s].hint));
check('подпись пояса непустая', tzLabel().length > 0, tzLabel());

// 1. Без навязчивости: страница ничего не спрашивает сама
{
  const b = await open({}, { permission: 'prompt', pre: stubOf(`ok({ coords: { latitude: 10.5, longitude: -20.25 } });`) });
  const p = await panel(b);
  check('idle: сайт сам не запрашивает геолокацию (0 вызовов), показана авторская точка', (await calls(b)).get === 0 && p.state === 'idle' && p.coords === AUTHOR && p.mode === 'author' && p.src === 'авторская точка', JSON.stringify(p));
  check('idle: кнопка видна, есть объяснение приватности в подсказке', !p.btnHidden && /не сохраняются и никуда не отправляются/.test(p.hint));
  // успех по нажатию
  await click(b); await b.waitFor(`document.getElementById('live-geo').dataset.state === 'granted'`, 4000);
  const q = await panel(b), c = await calls(b);
  check('клик → granted: координаты посетителя, источник «геолокация»', q.state === 'granted' && q.coords === '10°30′N 20°15′W' && q.mode === 'geolocation' && q.src === 'геолокация', JSON.stringify(q));
  check('параметры запроса: timeout 12000, maximumAge 600000, без высокой точности; watchPosition не вызывается', c.get === 1 && c.watch === 0 && c.opts.timeout === 12000 && c.opts.maximumAge === 600000 && c.opts.enableHighAccuracy === false, JSON.stringify(c));
  const store = await b.eval(`JSON.stringify({ l: Object.entries(localStorage), s: Object.entries(sessionStorage), c: document.cookie })`);
  check('приватность: координаты не в localStorage/sessionStorage/cookie', !/10\.5|20\.25|10°30|20°15/.test(store), store);
  const reqs = b.requests();
  check('приватность: ни один запрос не содержит координат', !reqs.some((u) => /10\.5|20\.25|lat=|lon=|latitude|longitude/i.test(decodeURIComponent(u))), `${reqs.length} запросов`);
  check('приватность: координаты не вынесены в title/атрибуты', !(await b.eval(`[...document.querySelectorAll('#live-geo *')].some(e => /10\\.5|20\\.25|10°30/.test([...e.attributes].map(a => a.value).join(' ')))`)));
  check('нет JS-ошибок', b.jsErrors().length === 0, b.jsErrors().join('; '));
  b.close();
}

// 2. Разрешение уже выдано: показываем место без повторного вопроса (эмуляция реального API)
{
  const b = await open({}, { permission: 'granted', override: true });
  await b.waitFor(`document.getElementById('live-geo').dataset.state === 'granted'`, 5000);
  const p = await panel(b);
  check('granted заранее: место показано автоматически без нажатия', p.coords === '10°30′N 20°15′W' && p.src === 'геолокация', JSON.stringify(p));
  b.close();
}

// 3. Состояния по ошибкам API (после нажатия)
const cases = [
  ['PERMISSION_DENIED (1)', stubOf(`setTimeout(() => err({ code: 1 }), 50);`), 'denied'],
  ['POSITION_UNAVAILABLE (2)', stubOf(`setTimeout(() => err({ code: 2 }), 50);`), 'unavailable'],
  ['TIMEOUT (3)', stubOf(`setTimeout(() => err({ code: 3 }), 50);`), 'timeout'],
  ['исключение внутри API', stubOf(`throw new Error('boom');`), 'error'],
  ['невалидные координаты', stubOf(`setTimeout(() => ok({ coords: { latitude: 999, longitude: NaN } }), 50);`), 'error'],
];
for (const [name, stub, expected] of cases) {
  const b = await open({}, { pre: stub });
  await click(b); await b.waitFor(`document.getElementById('live-geo').dataset.state === '${expected}'`, 3000);
  const p = await panel(b);
  check(`${name} → состояние «${expected}», авторская точка, причина в подсказке`, p.state === expected && p.coords === AUTHOR && p.mode === 'author' && p.src === 'авторская точка' && p.hint === GEO_TEXT[expected].hint, `${p.state} / ${p.btn}`);
  check(`  кнопка «${p.btn}» доступна для повтора, JS-ошибок нет`, !p.btnHidden && !p.btnDisabled && b.jsErrors().length === 0, b.jsErrors().join('; '));
  b.close();
}

// 4. loading, повтор после ошибки, отсутствие «вечной» загрузки
{
  const b = await open({}, { pre: `let n = 0;` + stubOf(`n++; if (n === 1) { setTimeout(() => err({ code: 3 }), 900); } else { setTimeout(() => ok({ coords: { latitude: 10.5, longitude: -20.25 } }), 50); }`) });
  await click(b); await b.wait(200);
  const l = await panel(b);
  check('loading: кнопка заблокирована, статус «определяем…», координаты авторские (без ложных)', l.state === 'loading' && l.btnDisabled && l.src === 'определяем…' && l.coords === AUTHOR && l.mode === 'author', JSON.stringify(l));
  await click(b); await b.wait(100);
  check('повторный клик во время loading не создаёт второй запрос', (await calls(b)).get === 1);
  await b.waitFor(`document.getElementById('live-geo').dataset.state === 'timeout'`, 3000);
  await click(b); await b.waitFor(`document.getElementById('live-geo').dataset.state === 'granted'`, 3000);
  const p = await panel(b);
  check('повтор после тайм-аута → granted (запросов 2)', p.state === 'granted' && (await calls(b)).get === 2, JSON.stringify(p));
  b.close();
}
{
  const b = await open({}, { pre: stubOf(`/* ни success, ни error */`) });
  await click(b); await b.wait(500);
  check('зависший запрос: сначала loading', (await panel(b)).state === 'loading');
  await b.waitFor(`document.getElementById('live-geo').dataset.state === 'timeout'`, 19000);
  const p = await panel(b);
  check('зависший запрос: страховочный таймер переводит в timeout (не бесконечная загрузка)', p.state === 'timeout' && p.coords === AUTHOR && !p.btnDisabled, JSON.stringify(p));
  b.close();
}

// 5. Отказ в настройках браузера: запрос API не отправляется, причина объяснена
{
  const b = await open({}, { permission: 'denied', pre: stubOf(`ok({ coords: { latitude: 10.5, longitude: -20.25 } });`) });
  const p = await panel(b);
  check('denied в браузере: состояние «denied» сразу, авторская точка', p.state === 'denied' && p.coords === AUTHOR && p.src === 'авторская точка', JSON.stringify(p));
  await click(b); await b.wait(500);
  check('denied: повторное нажатие не вызывает API и не навязывает запрос', (await calls(b)).get === 0 && (await panel(b)).state === 'denied');
  b.close();
}

// 6. API недоступен: нет navigator.geolocation / небезопасный контекст
for (const [name, pre] of [['navigator.geolocation отсутствует', `Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });`], ['небезопасный контекст (не HTTPS)', `Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });`]]) {
  const b = await open({}, { pre });
  const p = await panel(b);
  check(`fallback: ${name} → авторская точка, кнопка скрыта, причина в подсказке`, p.state === 'fallback' && p.btnHidden && p.coords === AUTHOR && p.hint === GEO_TEXT.fallback.hint && b.jsErrors().length === 0, JSON.stringify(p));
  b.close();
}

// 7. Время и часовой пояс (по устройству, а не по авторской точке)
for (const [zone, expect] of [['Europe/Belgrade', /^(CET|CEST)$/], ['Asia/Tokyo', /^UTC\+9$/], ['America/New_York', /^UTC-[45]$/], ['Asia/Kolkata', /^UTC\+5:30$/], ['UTC', /^UTC$/]]) {
  const b = await launch({ port: port++ });
  await b.send('Emulation.setTimezoneOverride', { timezoneId: zone });
  await b.goto(BASE, 400); await init(b);
  const p = await panel(b);
  const hh = await b.eval(`new Intl.DateTimeFormat('en-GB', { timeZone: ${JSON.stringify(zone)}, hour: '2-digit', hour12: false }).format(new Date())`);
  check(`пояс ${zone}: «${p.tz}», время устройства совпадает с поясом`, expect.test(p.tz) && p.clock.slice(0, 2) === String(hh).padStart(2, '0'), `${p.clock} ${p.tz}`);
  if (zone === 'UTC') {
    const t1 = p.clock; await b.wait(2200); const t2 = (await panel(b)).clock;
    check('время обновляется без перезагрузки', t1 !== t2, `${t1} → ${t2}`);
    await b.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' }); await b.wait(1500);
    check('смена часового пояса «на лету» отражается в панели', (await panel(b)).tz === 'UTC+9', (await panel(b)).tz);
  }
  b.close();
}

// 8. Макет: ширина блоков не меняется между состояниями
{
  const b = await open({}, { pre: stubOf(`setTimeout(() => ok({ coords: { latitude: 10.5, longitude: -20.25 } }), 50);`) });
  const m = () => b.eval(`JSON.stringify([...document.querySelectorAll('.meta-coords > *, .topbar-right, .status-pill')].map(e => Math.round(e.getBoundingClientRect().left) + ':' + Math.round(e.getBoundingClientRect().width)))`);
  const before = await m();
  await click(b); await b.waitFor(`document.getElementById('live-geo').dataset.state === 'granted'`, 3000); await b.wait(300);
  const after = await m();
  check('макет: положение и ширина блоков панели не меняются при смене состояния', before === after, before === after ? '' : before + ' → ' + after);
  await b.shot('/tmp/gonka-geo-topbar.png', { x: 0, y: 0, width: 900, height: 120 });
  b.close();
}

// 9. Клавиатура
{
  const b = await open({}, { pre: stubOf(`setTimeout(() => ok({ coords: { latitude: 10.5, longitude: -20.25 } }), 50);`) });
  await b.eval(`document.getElementById('geo-btn').focus()`);
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await b.waitFor(`document.getElementById('live-geo').dataset.state === 'granted'`, 3000);
  check('клавиатура: Enter на кнопке запускает определение', (await panel(b)).state === 'granted');
  check('доступность: подсказка — aria-live (role=status), кнопка связана через aria-describedby', await b.eval(`document.getElementById('geo-hint').getAttribute('role') === 'status' && document.getElementById('geo-btn').getAttribute('aria-describedby') === 'geo-hint'`));
  b.close();
}

// 10. Мобильная ширина: панель скрыта дизайном, запросов нет
{
  const b = await open({ width: 390, height: 844, mobile: true }, { permission: 'prompt' });
  const vis = await b.eval(`getComputedStyle(document.querySelector('.meta-coords')).display`);
  check('мобильная ширина: панель скрыта, запросов геолокации нет', vis === 'none' && (await calls(b)).get === 0, `display=${vis}`);
  check('мобильная ширина: нет горизонтального переполнения и JS-ошибок', (await b.eval(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)) && b.jsErrors().length === 0);
  b.close();
}

console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
