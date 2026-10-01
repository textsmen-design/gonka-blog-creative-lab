/* tools/admin/ui/app.js — UI админки GONKA.BLOG (vanilla JS).
 * Данные в DOM попадают только через textContent (без innerHTML). */
(() => {
  'use strict';

  const TABS = [
    { id: 'site', label: 'Сайт' },
    { id: 'links', label: 'Ссылки' },
    { id: 'media', label: 'Медиа' },
    { id: 'sections', label: 'Разделы' },
    { id: 'history', label: 'История' },
  ];

  const state = {
    token: sessionStorage.getItem('gonka-admin-token') || '',
    data: null,
    etags: null,
    work: null,
    tab: 'site',
    rawMode: false,
    rawParseOk: true,
    dirty: new Set(),
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  };

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const short = (h) => (h ? h.slice(0, 10) : '—');

  // ---------- API ----------
  async function api(pathname, opts = {}) {
    const res = await fetch(pathname, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + state.token,
        ...(opts.headers || {}),
      },
    });
    let body = null;
    try { body = await res.json(); } catch { /* пусто */ }
    if (res.status === 401) {
      state.token = '';
      sessionStorage.removeItem('gonka-admin-token');
      showGate('Токен не принят');
      throw new Error('unauthorized');
    }
    return { status: res.status, body };
  }

  // ---------- gate / load ----------
  function showGate(msg) {
    $('#app').hidden = true;
    $('#gate').hidden = false;
    const err = $('#gate-error');
    err.hidden = !msg;
    if (msg) err.textContent = msg;
  }

  async function load() {
    const { status, body } = await api('/api/data');
    if (status !== 200) {
      showGate('Сервер ответил ' + status + (body?.error ? ': ' + body.error : ''));
      return false;
    }
    state.data = body.data;
    state.etags = body.etags;
    state.work = {};
    for (const f of body.files) state.work[f] = clone(state.data[f]);
    state.dirty.clear();
    state.rawParseOk = true;
    $('#gate').hidden = true;
    $('#app').hidden = false;
    renderTabs();
    render();
    return true;
  }

  function showConnection(ok, text) {
    const c = $('#conn');
    c.textContent = text;
    c.className = 'pill' + (ok ? ' ok' : '');
  }

  // ---------- tabs ----------
  function renderTabs() {
    const nav = $('#tabs');
    nav.textContent = '';
    for (const t of TABS) {
      nav.append(
        el('button', {
          class: t.id === state.tab ? 'active' : '',
          type: 'button',
          onclick: () => { state.tab = t.id; renderTabs(); render(); },
        }, t.label)
      );
    }
  }

  // ---------- notices ----------
  function clearNotices() { $('#notices').textContent = ''; }
  function notice(kind, title, items = []) {
    const box = el('div', { class: 'notice ' + kind }, el('strong', {}, title));
    if (items.length) {
      const ul = el('ul');
      for (const it of items) {
        ul.append(el('li', {}, it.path ? `${it.path}: ${it.message}` : it.message || String(it)));
      }
      box.append(ul);
    }
    $('#notices').append(box);
  }

  // ---------- editor ----------
  function setPath(obj, path, value) {
    let node = obj;
    for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
    node[path[path.length - 1]] = value;
  }

  function markDirty(file) {
    const same = JSON.stringify(state.data[file]) === JSON.stringify(state.work[file]);
    if (same) state.dirty.delete(file);
    else state.dirty.add(file);
    updateToolbar();
  }

  function updateToolbar() {
    const isFile = state.tab !== 'history';
    const dirty = state.dirty.has(state.tab);
    $('#btn-save').disabled = !isFile || !dirty || (state.rawMode && !state.rawParseOk);
    const d = $('#dirty');
    d.textContent = isFile ? (dirty ? 'изменено' : 'без изменений') : '';
    d.className = 'pill' + (dirty ? ' dirty' : '');
    $('#btn-raw').hidden = !isFile;
    $('#btn-raw').textContent = state.rawMode ? 'Режим формы' : 'Режим JSON';
    $('#status').textContent = isFile
      ? `файл: ${state.tab}.json · загружен ${short(state.etags?.[state.tab])}` +
        (state.dirty.size ? ` · не сохранено: ${[...state.dirty].join(', ')}` : '')
      : 'резервные копии';
  }

  function field(label, value, onInput) {
    const ta = el('textarea', { rows: value.length > 80 || value.includes('\n') ? 4 : 2 });
    ta.value = value;
    ta.addEventListener('input', () => onInput(ta.value));
    return el('div', { class: 'field' }, el('label', {}, label), ta);
  }

  function renderValue(key, value, path, container, file) {
    if (typeof value === 'string') {
      container.append(field(key, value, (v) => {
        setPath(state.work[file], path, v);
        markDirty(file);
      }));
      return;
    }
    if (Array.isArray(value)) {
      const box = el('div', { class: 'arr' });
      box.append(el('div', { class: 'arr-head' },
        `${key} — ${value.length} элем. (добавление/удаление/перестановка отключены)`));
      value.forEach((item, i) => {
        renderValue(`[${i}]`, item, [...path, i], box, file);
      });
      container.append(box);
      return;
    }
    if (value && typeof value === 'object') {
      const box = el('div', { class: 'obj' });
      if (key) box.append(el('div', { class: 'obj-key' }, key));
      for (const [k, v] of Object.entries(value)) {
        renderValue(k, v, [...path, k], box, file);
      }
      container.append(box);
      return;
    }
    container.append(field(key + ' (' + typeof value + ')', String(value), (v) => {
      setPath(state.work[file], path, v);
      markDirty(file);
    }));
  }

  function renderEditor() {
    const host = $('#editor');
    host.textContent = '';
    const file = state.tab;
    const card = el('div', { class: 'file-card' },
      el('h2', {}, `${file}.json`));

    if (state.rawMode) {
      const ta = el('textarea', { class: 'raw-area', spellcheck: 'false' });
      ta.value = JSON.stringify(state.work[file], null, 2);
      ta.addEventListener('input', () => {
        try {
          const parsed = JSON.parse(ta.value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            state.work[file] = parsed;
            state.rawParseOk = true;
          } else {
            state.rawParseOk = false;
          }
        } catch {
          state.rawParseOk = false;
        }
        markDirty(file);
        updateToolbar();
        if (!state.rawParseOk) {
          clearNotices();
          notice('err', 'JSON не разобран', [{ message: 'сохранение отключено, пока JSON некорректен' }]);
        }
      });
      card.append(ta);
    } else {
      for (const [k, v] of Object.entries(state.work[file])) {
        renderValue(k, v, [k], card, file);
      }
    }
    host.append(card);
  }

  // ---------- diff ----------
  function computeDiff(a, b, prefix = '', out = []) {
    if (JSON.stringify(a) === JSON.stringify(b)) return out;
    const bothObj = a && b && typeof a === 'object' && typeof b === 'object'
      && Array.isArray(a) === Array.isArray(b);
    if (!bothObj) {
      out.push({ path: prefix, from: a, to: b });
      return out;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      computeDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }

  function trunc(v) {
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s === undefined) s = '—';
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }

  function showDiff() {
    const file = state.tab;
    const changes = computeDiff(state.data[file], state.work[file]);
    const box = $('#diffbox');
    const list = $('#diff-list');
    list.textContent = '';
    if (!changes.length) { box.hidden = true; return; }
    for (const c of changes) {
      list.append(el('div', { class: 'diff-row' },
        el('div', { class: 'p' }, c.path),
        el('div', { class: 'from' }, trunc(c.from)),
        el('div', { class: 'to' }, trunc(c.to))));
    }
    box.hidden = false;
  }

  async function doSave() {
    clearNotices();
    const file = state.tab;
    const { status, body } = await api('/api/save', {
      method: 'POST',
      body: JSON.stringify({ file, data: state.work[file], ifMatch: state.etags[file] }),
    });
    if (status === 200) {
      state.data[file] = clone(state.work[file]);
      state.etags[file] = body.etag;
      state.dirty.delete(file);
      $('#diffbox').hidden = true;
      clearNotices();
      if (body.warnings?.length) notice('warn', 'Сохранено с предупреждениями', body.warnings);
      else notice('ok', 'Сохранено', [{ message: `бэкап: ${body.backup}` }]);
      render();
    } else if (status === 409) {
      $('#diffbox').hidden = true;
      notice('err', 'Не сохранено', [{ message: body?.error || 'конфликт' }]);
      if (body?.code === 'etag') {
        notice('warn', 'Файл изменён вне админки — нажмите «Перезагрузить» и повторите правку');
      }
    } else if (status === 422) {
      notice('err', 'Валидация не пройдена — файл не изменён', body?.errors || []);
      if (body?.warnings?.length) notice('warn', 'Предупреждения', body.warnings);
    } else {
      notice('err', 'Ошибка ' + status, [{ message: body?.error || '' }]);
    }
  }

  // ---------- history ----------
  async function renderHistory() {
    const host = $('#history-list');
    host.textContent = '';
    const { status, body } = await api('/api/backups');
    if (status !== 200) { notice('err', 'Не удалось получить историю'); return; }
    const rows = body.backups || [];
    if (!rows.length) { host.append(el('p', { class: 'muted' }, 'Бэкапов пока нет.')); return; }
    const table = el('table');
    table.append(el('tr', {}, el('th', {}, 'Файл'), el('th', {}, 'Время (UTC)'),
      el('th', {}, 'Размер'), el('th', {}, '')));
    for (const b of rows) {
      const when = new Date(b.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
      table.append(el('tr', {},
        el('td', {}, b.file + '.json'),
        el('td', {}, when),
        el('td', {}, b.size + ' Б'),
        el('td', {}, el('button', {
          class: 'danger', type: 'button',
          onclick: () => restoreBackup(b),
        }, 'Восстановить'))));
    }
    host.append(table);
  }

  async function restoreBackup(b) {
    if (!confirm(`Восстановить ${b.file}.json из копии от ${new Date(b.mtimeMs).toISOString()}?`)) return;
    clearNotices();
    const { status, body } = await api('/api/restore', {
      method: 'POST',
      body: JSON.stringify({ name: b.name, ifMatch: state.etags[b.file] }),
    });
    if (status === 200) {
      state.etags[b.file] = body.etag;
      const fresh = await api('/api/data');
      if (fresh.status === 200) {
        state.data = fresh.body.data;
        for (const f of fresh.body.files) state.work[f] = clone(state.data[f]);
        state.dirty.clear();
      }
      notice('ok', `Восстановлено: ${b.file}.json`);
      render();
    } else if (status === 409) {
      notice('err', 'Конфликт — файл изменён, перезагрузите данные', [{ message: body?.error || '' }]);
    } else {
      notice('err', 'Ошибка ' + status, body?.errors || [{ message: body?.error || '' }]);
    }
  }

  // ---------- render ----------
  function render() {
    const isHistory = state.tab === 'history';
    $('#editor').hidden = isHistory;
    $('#history').hidden = !isHistory;
    $('#diffbox').hidden = true;
    if (isHistory) renderHistory();
    else renderEditor();
    updateToolbar();
  }

  // ---------- events ----------
  $('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.token = $('#gate-token').value.trim();
    if (!state.token) return;
    sessionStorage.setItem('gonka-admin-token', state.token);
    $('#gate-error').hidden = true;
    const ok = await load().catch(() => false);
    if (!ok && state.token) showGate('Токен не принят (проверьте tools/admin/.token)');
  });

  $('#btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('gonka-admin-token');
    state.token = '';
    showGate();
  });

  $('#btn-reload').addEventListener('click', async () => {
    if (state.dirty.size && !confirm('Есть несохранённые правки. Перезагрузить данные?')) return;
    clearNotices();
    await load();
  });

  $('#btn-save').addEventListener('click', showDiff);
  $('#btn-cancel').addEventListener('click', () => { $('#diffbox').hidden = true; });
  $('#btn-confirm').addEventListener('click', doSave);

  $('#btn-raw').addEventListener('click', () => {
    state.rawMode = !state.rawMode;
    state.rawParseOk = true;
    clearNotices();
    render();
  });

  // ---------- start ----------
  (async () => {
    if (!state.token) { showGate(); return; }
    const ok = await load().catch(() => false);
    if (!ok && state.token) showGate('Сессия истекла или токен неверен');
    else showConnection(true, 'localhost:' + (location.port || '80'));
  })();
})();
