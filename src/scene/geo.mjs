// src/scene/geo.mjs — чистые функции для верхней панели: формат координат и подпись часового пояса.
// Без обращений к сети и хранилищам. Используются в SpatialWorkbench.astro и в тестах.

// Авторская точка (запасной вариант, если геолокация недоступна или запрещена)
export const AUTHOR_POINT = { lat: 45.25, lon: 19.85, text: '45°15′N 19°51′E' };

// Градусы и минуты (≈ 2 км точности), например 44°49′N 20°27′E. Невалидные значения → null.
export function formatCoords(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const part = (v, pos, neg) => {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.round((a - d) * 60);
    if (m === 60) { d += 1; m = 0; }
    return `${d}°${String(m).padStart(2, '0')}′${v >= 0 ? pos : neg}`;
  };
  return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
}

// Подпись часового пояса посетителя: CEST/BST и т.п., а для «GMT+3» — «UTC+3». Запасной вариант — UTC±часы из смещения.
export function tzLabel(date = new Date()) {
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
      .formatToParts(date).find((p) => p.type === 'timeZoneName');
    if (part && part.value) return part.value.replace(/^GMT(?=[+-])/, 'UTC').replace(/^GMT$/, 'UTC');
  } catch { /* Intl недоступен */ }
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(off) / 60), m = Math.abs(off) % 60;
  return `UTC${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

export function tzName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
}

export function clockText(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

// ---- Состояния определения местоположения ----
// idle → loading → granted | denied | unavailable | timeout | error; fallback — API недоступен (нет поддержки/небезопасный контекст)
export const GEO_STATES = ['idle', 'loading', 'granted', 'denied', 'unavailable', 'timeout', 'error', 'fallback'];

export const GEO_TEXT = {
  idle:        { src: 'авторская точка', btn: 'определить', hint: 'Определить ваше местоположение? Браузер спросит разрешение. Координаты остаются только в вашем браузере: не сохраняются и никуда не отправляются.' },
  loading:     { src: 'определяем…',     btn: '…',          hint: 'Определяем местоположение. Если браузер показал запрос, разрешите доступ.' },
  granted:     { src: 'геолокация',      btn: 'обновить',   hint: 'Показано определённое браузером местоположение. Оно видно только вам.' },
  denied:      { src: 'авторская точка', btn: 'повторить',  hint: 'Доступ к местоположению запрещён. Показана авторская точка. Разрешить можно в настройках сайта в браузере, затем нажмите «повторить».' },
  unavailable: { src: 'авторская точка', btn: 'повторить',  hint: 'Устройство не смогло определить местоположение (проверьте службы геолокации в системе). Показана авторская точка.' },
  timeout:     { src: 'авторская точка', btn: 'повторить',  hint: 'Местоположение не определилось вовремя. Показана авторская точка.' },
  error:       { src: 'авторская точка', btn: 'повторить',  hint: 'Не удалось определить местоположение. Показана авторская точка.' },
  fallback:    { src: 'авторская точка', btn: '',           hint: 'Определение местоположения недоступно в этом браузере или на этой странице (нужен HTTPS). Показана авторская точка.' },
};

// Код ошибки Geolocation API → состояние (1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT)
export function stateFromError(err) {
  const code = err && typeof err === 'object' ? err.code : undefined;
  return code === 1 ? 'denied' : code === 2 ? 'unavailable' : code === 3 ? 'timeout' : 'error';
}
