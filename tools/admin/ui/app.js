/* tools/admin/ui/app.js — UI админки GONKA.BLOG (vanilla JS).
 * Данные в DOM попадают только через textContent (без innerHTML). */
(() => {
  'use strict';

  const TABS = [
    { id: 'slots', label: 'Резервные плашки' },
    { id: 'landings', label: 'Лендинги' },
    { id: 'trackers', label: 'Трекеры' },
    { id: 'bots', label: 'Боты' },
    { id: 'site', label: 'Сайт' },
    { id: 'links', label: 'Ссылки' },
    { id: 'media', label: 'Медиа' },
    { id: 'sections', label: 'Разделы' },
    { id: 'scene', label: 'Предметы' },
    { id: 'history', label: 'История' },
  ];

  const state = {
    token: sessionStorage.getItem('gonka-admin-token') || '',
    data: null,
    etags: null,
    work: null,
    tab: 'slots',
    rawMode: false,
    rawParseOk: true,
    dirty: new Set(),
  };

  // вкладки, редактирующие один файл projects.json
  const PROJECT_TAB_IDS = ['slots', 'landings', 'trackers', 'bots'];
  const fileOfTab = (tab) => (PROJECT_TAB_IDS.includes(tab) ? 'projects' : tab);

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
  // общий с сервером модуль операций над проектами (архив, дубликаты, поиск, целостность)
  let ops = null;
  const opsReady = import('/ui/project-ops.mjs').then((m) => { ops = m; });
  const short = (h) => (h ? h.slice(0, 10) : '—');

  function slugify(text) {
    return text.toString().toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w-]+/g, '')
      .replace(/--+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '') || ('project-' + Date.now().toString(36));
  }

  // ---------- API ----------
  async function api(pathname, opts = {}) {
    const res = await fetch(pathname, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': state.token,
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

  const REQUIRED_API = 4;
  // Работающий процесс админки мог быть запущен на старой версии кода (интерфейс читается с диска каждый раз, а сервер живёт в памяти).
  async function checkServerVersion() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      if (r.status !== 200) return false;
      const j = await r.json();
      return Number(j.apiVersion) >= REQUIRED_API;
    } catch { return false; }
  }

  async function load() {
    await opsReady;
    state.versionError = false;
    if (!(await checkServerVersion())) {
      state.versionError = true;
      showGate('Сервер админки запущен на устаревшей версии кода (или не отвечает). Остановите его (Ctrl+C) и запустите заново командой «npm run admin» в папке проекта. Токен здесь ни при чём.');
      return false;
    }
    const { status, body } = await api('/api/data');
    if (status !== 200) {
      showGate('Сервер ответил ' + status + (body?.error ? ': ' + body.error : ''));
      return false;
    }
    state.data = body.data;
    state.etags = body.etags;
    state.work = {};
    for (const f of body.files) state.work[f] = clone(state.data[f]);
    if (state.work.site?.desk?.['modal-serbia-wip']) {
      if (!state.work.site.desk['modal-trackers']) {
        state.work.site.desk['modal-trackers'] = {
          tag: state.work.site.desk['modal-serbia-wip'].tag || 'ТАСК-ТРЕКЕРЫ',
          statement: state.work.site.desk['modal-serbia-wip'].statement || '«Внутренние рабочие инструменты и таск-трекеры.»',
        };
      } else if (state.work.site.desk['modal-serbia-wip'].tag) {
        state.work.site.desk['modal-trackers'].tag = state.work.site.desk['modal-serbia-wip'].tag;
      }
      if (!state.work.site.desk['modal-srbija']) {
        state.work.site.desk['modal-srbija'] = {
          tag: 'SRBIJA',
          statement: '«Полевое исследование и личный R&D.»',
        };
      }
      delete state.work.site.desk['modal-serbia-wip'];
    }
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
          onclick: () => {
            state.tab = t.id;
            state.rawMode = false;
            renderTabs();
            render();
          },
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

  // ---------- editor helpers ----------
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
    const isHistory = state.tab === 'history';
    const isSlots = state.tab === 'slots';
    const isLandings = state.tab === 'landings';
    const isTrackers = state.tab === 'trackers';
    const isBots = state.tab === 'bots';
    const activeFile = fileOfTab(state.tab);
    const dirty = !isHistory && state.dirty.has(activeFile);

    $('#btn-save').disabled = isHistory || !dirty || (state.rawMode && !state.rawParseOk);
    const d = $('#dirty');
    d.textContent = !isHistory ? (dirty ? 'есть черновик' : 'сохранено') : '';
    d.className = 'pill' + (dirty ? ' dirty' : ' ok');
    $('#btn-raw').hidden = isHistory || PROJECT_TAB_IDS.includes(state.tab);
    $('#btn-raw').textContent = state.rawMode ? 'Режим формы' : 'Режим JSON';

    if (isSlots) {
      $('#status').textContent = `Резервные плашки верстака (6 слотов) · projects.json · ${short(state.etags?.projects)}`;
    } else if (isLandings) {
      const count = state.work?.projects?.landings?.length || 0;
      $('#status').textContent = `Лендинги (${count} проектов) · projects.json · ${short(state.etags?.projects)}`;
    } else if (isTrackers) {
      const count = state.work?.projects?.trackers?.length || 0;
      $('#status').textContent = `Трекеры (${count} проектов) · projects.json · ${short(state.etags?.projects)}`;
    } else if (isBots) {
      const count = state.work?.projects?.bots?.length || 0;
      $('#status').textContent = `Боты (${count} проектов) · projects.json · ${short(state.etags?.projects)}`;
    } else if (!isHistory) {
      $('#status').textContent = `файл: ${state.tab}.json · загружен ${short(state.etags?.[state.tab])}` +
        (state.dirty.size ? ` · не сохранено: ${[...state.dirty].join(', ')}` : '');
    } else {
      $('#status').textContent = 'резервные копии';
    }
  }

  // ---------- 1. РЕЗЕРВНЫЕ ПЛАШКИ (6 СЛОТОВ) ----------
  function renderSlots() {
    const host = $('#slots-view');
    host.textContent = '';

    const header = el('div', { class: 'slots-header' },
      el('h2', {}, '6 резервных плашек на верстаке'),
      el('p', { class: 'muted small' }, 'Каждый слот привязан к реальному объекту стола. При назначении проекта он становится активным на верстаке.')
    );
    host.append(header);

    const grid = el('div', { class: 'slots-grid' });
    const slots = state.work?.projects?.slots || [];

    const objectLabels = {
      lamp: 'Объект: Настольная металлическая лампа (вверху)',
      mug: 'Объект: Керамическая кружка «IDEAS BUILD TEST REPEAT»',
      compass: 'Объект: Морской латунный компас (по центру)',
      photos: 'Объект: Две фотографии пейзажей (блок-плашка)',
      magnifier: 'Объект: Увеличительное стекло (под телефоном)',
      pencilcup: 'Объект: Стакан с карандашами и ручками (в центре)',
    };

    slots.forEach((slot, index) => {
      const isAssigned = slot.assigned && slot.project;
      const p = slot.project || {};

      const card = el('div', { class: 'slot-card' + (isAssigned ? ' is-assigned' : '') });

      const statusClass = isAssigned ? (p.status || 'draft') : 'empty';
      const statusLabel = isAssigned
        ? (p.status === 'published' ? 'Опубликован' : p.status === 'hidden' ? 'Скрыт' : 'Черновик')
        : 'Свободен';

      const top = el('div', { class: 'slot-top' },
        el('div', {},
          el('div', { class: 'slot-name' }, slot.slotName),
          el('div', { class: 'slot-object-desc' }, objectLabels[slot.slotId] || `Слот: ${slot.slotId}`)
        ),
        el('span', { class: 'badge-pill ' + statusClass }, statusLabel)
      );
      card.append(top);

      if (isAssigned) {
        const info = el('div', { class: 'slot-project-info' },
          el('div', { class: 'slot-project-title' }, p.name || 'Без названия'),
          el('div', { class: 'slot-project-lead' }, p.lead || 'Нет описания'),
          p.url ? el('a', { class: 'slot-project-url', href: p.url, target: '_blank', rel: 'noopener' }, `Сайт: ${p.url}`) : null
        );
        card.append(info);

        const actions = el('div', { class: 'slot-actions' },
          el('button', {
            type: 'button',
            onclick: () => openProjectModal('slot', index),
          }, 'Редактировать проект'),
          el('button', {
            type: 'button',
            class: 'ghost danger',
            onclick: () => clearSlot(index),
          }, 'Снять назначение')
        );
        card.append(actions);
      } else {
        const emptyBox = el('div', { class: 'slot-project-info' },
          el('p', { class: 'muted small', style: 'margin: 0;' },
            'Слот свободен. На столе отображается как резервный без демонстрационных текстов.'
          )
        );
        card.append(emptyBox);

        const actions = el('div', { class: 'slot-actions' },
          el('button', {
            type: 'button',
            onclick: () => openAssignModal(index),
          }, 'Назначить проект')
        );
        card.append(actions);
      }

      grid.append(card);
    });

    host.append(grid);
  }

  function clearSlot(index) {
    const slot = state.work.projects.slots[index];
    if (!confirm(`Снять назначение со слота «${slot.slotName}»? Слот перейдет в резерв, а проект останется в каталоге.`)) return;
    slot.assigned = false;
    slot.assignedProjectId = null;
    slot.project = null;
    markDirty('projects');
    render();
  }

  function openAssignModal(slotIndex) {
    const slot = state.work.projects.slots[slotIndex];
    $('#assign-slot-index').value = String(slotIndex);
    $('#assign-modal-title').textContent = `Назначить проект: ${slot.slotName}`;

    const sel = $('#assign-project-select');
    sel.textContent = '';

    const allProjects = [
      ...(state.work.projects.trackers || []).filter((p) => !ops.isArchived(p)).map(p => ({ ...p, group: 'Трекеры' })),
      ...(state.work.projects.landings || []).filter((p) => !ops.isArchived(p)).map(p => ({ ...p, group: 'Лендинги' })),
    ];

    allProjects.forEach(p => {
      const alreadySlot = (state.work.projects.slots || []).find(s => s.assignedProjectId === p.id || (s.assigned && s.project?.id === p.id));
      const opt = el('option', { value: `${p.type || (p.group === 'Трекеры' ? 'tracker' : 'landing')}:${p.id}` },
        `[${p.group}] ${p.name}` + (alreadySlot ? ` (на: ${alreadySlot.slotName})` : '')
      );
      sel.append(opt);
    });

    if (allProjects.length === 0) {
      sel.append(el('option', { value: '' }, 'Нет проектов в каталогах'));
    }

    $('#assign-modal').hidden = false;
  }

  function closeAssignModal() {
    $('#assign-modal').hidden = true;
  }

  // ---------- 2. ПРОЕКТЫ: ЛЕНДИНГИ / ТРЕКЕРЫ / БОТЫ (архив, дубликаты, поиск, предпросмотр) ----------
  const VIEW = { landings: '#landings-view', trackers: '#trackers-view', bots: '#bots-view' };
  const NOUN = { landings: 'лендинг', trackers: 'трекер', bots: 'бота' };
  const HEAD = { landings: 'Лендинги', trackers: 'Трекеры', bots: 'Telegram-боты' };
  const ADD = { landings: '+ Добавить лендинг', trackers: '+ Добавить трекер', bots: '+ Добавить бота' };
  const filters = { landings: { q: '', status: 'active' }, trackers: { q: '', status: 'active' }, bots: { q: '', status: 'active' } };
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso || ''; } };

  function openEditor(group, index) {
    if (group === 'bots') openBotModal(index);
    else openProjectModal(group === 'landings' ? 'landing' : 'tracker', index);
  }

  function renderProjects(group) {
    const host = $(VIEW[group]);
    host.textContent = '';
    const projects = state.work?.projects || {};
    const all = projects[group] || [];
    const f = filters[group];
    const archived = all.filter(ops.isArchived).length;

    host.append(el('div', { class: 'landings-header' },
      el('h2', {}, `${HEAD[group]}: ${all.length - archived} активных` + (archived ? `, в архиве: ${archived}` : '')),
      el('button', { type: 'button', class: 'primary', onclick: () => openEditor(group, -1) }, ADD[group])
    ));

    const q = el('input', { type: 'search', class: 'pv-search', placeholder: 'Поиск: название, ссылка, описание…', 'aria-label': 'Поиск проектов' });
    q.value = f.q;
    const st = el('select', { class: 'pv-status', 'aria-label': 'Фильтр по статусу' },
      ...[['active', 'Активные'], ['published', 'Опубликованные'], ['draft', 'Черновики'], ['hidden', 'Скрытые'], ['archived', 'Архив'], ['all', 'Все']]
        .map(([v, l]) => { const o = el('option', { value: v }, l); if (f.status === v) o.selected = true; return o; }));
    const list = el('div', { class: 'landings-list', 'data-group': group });
    q.addEventListener('input', () => { f.q = q.value; renderProjectRows(group, list); });
    st.addEventListener('change', () => { f.status = st.value; render(); });
    host.append(el('div', { class: 'pv-toolbar' }, q, st,
      el('button', { type: 'button', class: 'ghost', onclick: showIntegrity }, 'Проверка целостности')));
    host.append(list);
    renderProjectRows(group, list);
  }

  function renderProjectRows(group, list) {
    list.textContent = '';
    const projects = state.work.projects;
    const f = filters[group];
    const found = ops.searchProjects(projects, { q: f.q, group, status: f.status });
    const reorderable = !f.q && f.status === 'active';
    if (!found.length) {
      list.append(el('p', { class: 'muted' }, f.q || f.status !== 'active' ? 'Ничего не найдено по текущему поиску и фильтру.' : 'Пока нет проектов.'));
      return;
    }
    found.forEach(({ index, item: p }) => {
      const archived = ops.isArchived(p);
      const row = el('div', { class: 'landing-row' + (archived ? ' is-archived' : '') });
      const thumb = group === 'bots' ? p.screenPreview : p.screenPreview;
      if (thumb) row.append(el('img', { class: 'landing-thumb', src: thumb, alt: p.name, onerror: (e) => { e.target.style.display = 'none'; } }));
      const url = group === 'bots' ? p.botUrl : p.url;
      row.append(el('div', { class: 'landing-info' },
        el('div', { class: 'landing-title-row' },
          el('span', { class: 'landing-name' }, p.name),
          el('span', { class: 'landing-badge' }, p.badge || p.catalogBadge || NOUN[group].toUpperCase()),
          el('span', { class: 'badge-pill ' + p.status }, ops.STATUS_LABEL[p.status] || p.status)),
        el('div', { class: 'landing-lead' }, p.lead || p.catalogDesc || p.desc || ''),
        url ? el('a', { class: 'landing-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, url) : null,
        archived ? el('div', { class: 'muted small' }, `В архиве с ${fmtDate(p.archivedAt)}` + (p.archivedSlotId ? ` · был в слоте «${p.archivedSlotId}»` : '')) : null));
      const btn = (label, cls, title, fn, disabled) => el('button', { type: 'button', class: cls || '', title: title || '', ...(disabled ? { disabled: '' } : {}), onclick: fn }, label);
      const actions = el('div', { class: 'landing-actions' });
      if (!archived) {
        actions.append(
          btn('Редактировать', '', '', () => openEditor(group, index)),
          btn('Предпросмотр', 'ghost', 'Как проект выглядит в каталоге и досье', () => showPreview(group, p)),
          btn(p.status === 'published' ? 'Скрыть' : 'Опубликовать', 'ghost', '', () => { p.status = p.status === 'published' ? 'hidden' : 'published'; markDirty('projects'); render(); }),
          btn('▲', 'ghost', reorderable ? 'Выше' : 'Порядок меняется в списке «Активные» без поиска', () => moveProject(group, index, -1), !reorderable),
          btn('▼', 'ghost', reorderable ? 'Ниже' : 'Порядок меняется в списке «Активные» без поиска', () => moveProject(group, index, 1), !reorderable),
          btn('Дублировать', 'ghost', 'Создать копию-черновик с новым id', () => duplicateAction(group, p)),
          btn('В архив', 'ghost danger', 'Убрать с сайта, данные сохраняются', () => archiveAction(group, p)));
      } else {
        actions.append(
          btn('Предпросмотр', 'ghost', '', () => showPreview(group, p)),
          btn('Восстановить', 'primary', 'Вернуть проект из архива', () => restoreAction(group, p)),
          btn('Удалить навсегда', 'ghost danger', 'Необратимо: потребуется ввести название', () => deleteForeverAction(group, p)));
      }
      row.append(actions);
      list.append(row);
    });
  }

  function moveProject(group, index, dir) {
    const arr = state.work.projects[group];
    let t = index + dir;
    while (t >= 0 && t < arr.length && ops.isArchived(arr[t])) t += dir; // архивные пропускаем
    if (t < 0 || t >= arr.length) return;
    [arr[index], arr[t]] = [arr[t], arr[index]];
    markDirty('projects');
    render();
  }

  function archiveAction(group, p) {
    const slot = (state.work.projects.slots || []).find((s) => s.assignedProjectId === p.id || (s.assigned && s.project?.id === p.id));
    const extra = slot ? `\n\nОн стоит в резервной плашке «${slot.slotName}» — плашка освободится (при восстановлении вернётся, если будет свободна).` : '';
    if (!confirm(`Перевести «${p.name}» в архив?\n\nПроект исчезнет с сайта, но все данные сохранятся; восстановить можно во вкладке «Архив».${extra}`)) return;
    const r = ops.archiveProject(state.work.projects, group, p.id);
    if (!r.ok) { notice('err', 'Не удалось архивировать', [{ message: r.error }]); return; }
    markDirty('projects');
    render();
    notice('ok', `«${p.name}» перенесён в архив`, [{ message: 'Нажмите «Сохранить черновик», чтобы изменения применились.' }]);
  }

  function restoreAction(group, p) {
    const r = ops.restoreProject(state.work.projects, group, p.id);
    if (!r.ok) { notice('err', 'Не удалось восстановить', [{ message: r.error }]); return; }
    markDirty('projects');
    filters[group].status = 'active';
    render();
    const lines = [{ message: `Статус: ${ops.STATUS_LABEL[r.status]}.` }];
    if (r.restoredSlot) lines.push({ message: `Возвращён в резервную плашку «${r.restoredSlot}».` });
    if (r.slotBusy) lines.push({ message: `Плашка «${r.slotBusy}» уже занята — проект остался в каталоге без плашки.` });
    notice('ok', `«${p.name}» восстановлен`, lines);
  }

  function duplicateAction(group, p) {
    const r = ops.duplicateProject(state.work.projects, group, p.id);
    if (!r.ok) { notice('err', 'Не удалось создать копию', [{ message: r.error }]); return; }
    markDirty('projects');
    filters[group].status = 'active'; filters[group].q = '';
    render();
    notice('ok', `Создана копия «${p.name} (копия)»`, [{ message: `Новый id: ${r.id}. Копия — черновик, на сайт не попадает и не стоит в плашках.` }]);
  }

  function deleteForeverAction(group, p) {
    confirmDangerous({
      title: `Удалить «${p.name}» навсегда?`,
      lines: ['Проект будет удалён из данных. Вернуть его можно только из резервной копии (вкладка «История»).', 'Чтобы подтвердить, введите название проекта точно так, как оно написано ниже.'],
      word: p.name,
      action: () => {
        const r = ops.deleteForever(state.work.projects, group, p.id);
        if (!r.ok) { notice('err', 'Не удалось удалить', [{ message: r.error }]); return; }
        markDirty('projects');
        render();
        notice('warn', `«${p.name}» удалён навсегда`, [{ message: 'Нажмите «Сохранить черновик» — перед записью создастся резервная копия.' }]);
      },
    });
  }

  function confirmDangerous({ title, lines, word, action }) {
    $('#danger-title').textContent = title;
    const body = $('#danger-body'); body.textContent = '';
    lines.forEach((l) => body.append(el('p', {}, l)));
    $('#danger-word').textContent = word;
    const inp = $('#danger-input'); inp.value = '';
    const ok = $('#danger-ok'); ok.disabled = true;
    inp.oninput = () => { ok.disabled = inp.value.trim() !== word; };
    ok.onclick = () => { $('#danger-modal').hidden = true; action(); };
    $('#danger-cancel').onclick = () => { $('#danger-modal').hidden = true; };
    $('#danger-modal').hidden = false;
    inp.focus();
  }

  function showIntegrity() {
    clearNotices();
    const r = ops.checkIntegrity(state.work.projects);
    if (!r.errors.length && !r.warnings.length) { notice('ok', 'Проверка целостности: проблем не найдено', [{ message: 'Повторов id и панелей нет, ссылки слотов корректны, архивные проекты не стоят в плашках.' }]); return; }
    if (r.errors.length) notice('err', `Целостность: ошибок ${r.errors.length}`, r.errors);
    if (r.warnings.length) notice('warn', `Целостность: предупреждений ${r.warnings.length}`, r.warnings);
  }

  // ---------- предпросмотр (схематичный: каталог + досье; без перехода на сайт) ----------
  function showPreview(group, p) {
    const host = $('#preview-body'); host.textContent = '';
    const url = group === 'bots' ? p.botUrl : p.url;
    host.append(el('p', { class: 'muted small' }, 'Схематичный предпросмотр данных проекта. Точный вид на сайте зависит от оформления сцены; предпросмотр на сайте — этап публикации.'));
    const card = el('div', { class: 'pv-card' },
      p.screenPreview ? el('img', { class: 'pv-img', src: p.screenPreview, alt: p.screenAlt || p.name, onerror: (e) => { e.target.style.display = 'none'; } }) : null,
      el('div', { class: 'pv-card-head' }, el('strong', {}, p.name || '(без названия)'), el('span', { class: 'landing-badge' }, p.badge || p.catalogBadge || ''), el('span', { class: 'badge-pill ' + (p.status || 'draft') }, ops.STATUS_LABEL[p.status] || p.status || '')),
      el('p', {}, p.catalogDesc || p.desc || p.lead || ''),
      url ? el('div', { class: 'muted small' }, `Ссылка: ${url}`) : el('div', { class: 'muted small' }, 'Ссылка не указана'));
    host.append(el('h3', {}, 'Карточка в каталоге'), card);
    (p.catalogSections || []).forEach((sec) => {
      card.append(el('div', { class: 'pv-block' }, el('em', {}, sec.title || ''),
        sec.items ? el('ul', {}, ...sec.items.map((i) => el('li', {}, i))) : el('p', {}, sec.text || '')));
    });
    host.append(el('h3', {}, 'Досье (панель справа)'));
    const dos = el('div', { class: 'pv-card' },
      el('div', { class: 'muted small' }, [p.headerTag, p.headerBadge].filter(Boolean).join('  ·  ')),
      el('div', { class: 'muted small' }, p.heroStatus || ''),
      el('h4', {}, p.name || ''), el('p', {}, p.lead || ''));
    (p.blocks || []).forEach((b) => {
      dos.append(el('div', { class: 'pv-block' }, el('em', {}, b.heading || ''),
        b.text ? el('p', {}, b.text) : null,
        b.items ? el('ul', {}, ...b.items.map((i) => el('li', {}, i))) : null,
        b.specs ? el('div', {}, ...b.specs.map((sp) => el('div', { class: 'muted small' }, `${sp[0]} ${sp[1]}`))) : null,
        b.result ? el('p', {}, b.result) : null));
    });
    if (Array.isArray(p.actions) && p.actions.length) dos.append(el('div', { class: 'muted small' }, 'Кнопки: ' + p.actions.join('  |  ')));
    host.append(dos);
    $('#preview-modal').hidden = false;
  }
  $('#preview-close').addEventListener('click', () => { $('#preview-modal').hidden = true; });

  // ---------- редактор бота ----------
  const emptyBot = () => ({
    type: 'bot', status: 'draft', accent: 'emerald', badge: 'АКТИВЕН', name: '', screenBadge: '', screenPreview: '', screenAlt: '',
    catalogDesc: '', catalogSections: [{ title: '// ЧТО ДЕЛАЕТ БОТ:', text: '' }, { title: '// ВОЗМОЖНОСТИ:', items: ['Описание в разработке'] }],
    catalogActions: ['ОТКРЫТЬ ДОСЬЕ ➔', 'В TELEGRAM ↗'], botUrl: '', launchTitle: '',
    headerTag: '[ АРХИВ // БОТ ]', headerBadge: 'TELEGRAM-БОТ', heroStatus: '● СТАТУС: БОТ РАБОТАЕТ В TELEGRAM', lead: '',
    actions: ['ЗАПУСТИТЬ В TELEGRAM ↗', 'СВЯЗАТЬСЯ В TELEGRAM ↗', '← К КАТАЛОГУ БОТОВ'],
    blocks: [{ heading: '// О ПРОЕКТЕ', text: '' }, { heading: '// ЧТО СДЕЛАНО', items: ['Описание в разработке'] }, { heading: '// ТЕХНОЛОГИИ', specs: [['Язык:', '—']] }, { heading: '// РЕЗУЛЬТАТ', result: '' }],
  });
  const BOT_FIELDS = [
    { k: 'name', label: 'Название бота', req: true }, { k: 'status', label: 'Статус', type: 'select', options: [['published', 'Опубликован'], ['draft', 'Черновик'], ['hidden', 'Скрыт']] },
    { k: 'accent', label: 'Цвет акцента', type: 'select', options: [['emerald', 'Зелёный'], ['purple', 'Фиолетовый'], ['blue', 'Синий'], ['amber', 'Янтарный']] }, { k: 'badge', label: 'Бейдж в каталоге' },
    { k: 'botUrl', label: 'Ссылка на бота (https://t.me/…)', req: true, full: true }, { k: 'launchTitle', label: 'Подсказка кнопки запуска', full: true },
    { k: 'screenPreview', label: 'Превью (путь /previews/имя.png|jpg|webp)', full: true }, { k: 'screenAlt', label: 'Описание превью (alt)', full: true }, { k: 'screenBadge', label: 'Подпись на превью' },
    { k: 'catalogDesc', label: 'Краткое описание (каталог)', type: 'textarea', full: true },
    { k: 'catalogSections.0.title', label: 'Каталог: заголовок блока 1' }, { k: 'catalogSections.0.text', label: 'Каталог: текст блока 1', type: 'textarea', full: true },
    { k: 'catalogSections.1.title', label: 'Каталог: заголовок блока 2' }, { k: 'catalogSections.1.items', label: 'Каталог: пункты блока 2 (по строке)', type: 'lines', full: true },
    { k: 'catalogActions.0', label: 'Каталог: кнопка «досье»' }, { k: 'catalogActions.1', label: 'Каталог: кнопка «в Telegram»' },
    { k: 'headerTag', label: 'Досье: метка' }, { k: 'headerBadge', label: 'Досье: бейдж' }, { k: 'heroStatus', label: 'Досье: статус', full: true }, { k: 'lead', label: 'Досье: вводный текст', type: 'textarea', full: true },
    { k: 'actions.0', label: 'Досье: кнопка запуска' }, { k: 'actions.1', label: 'Досье: кнопка «связаться»' }, { k: 'actions.2', label: 'Досье: кнопка «к каталогу»' },
    { k: 'blocks.0.heading', label: 'Блок 1: заголовок' }, { k: 'blocks.0.text', label: 'Блок 1: текст', type: 'textarea', full: true },
    { k: 'blocks.1.heading', label: 'Блок 2: заголовок' }, { k: 'blocks.1.items', label: 'Блок 2: пункты (по строке)', type: 'lines', full: true },
    { k: 'blocks.2.heading', label: 'Блок 3: заголовок' }, { k: 'blocks.2.specs', label: 'Блок 3: параметры («Ключ: значение», по строке)', type: 'pairs', full: true },
    { k: 'blocks.3.heading', label: 'Блок 4: заголовок' }, { k: 'blocks.3.result', label: 'Блок 4: результат', type: 'textarea', full: true },
  ];
  const getDot = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  const setDot = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); const t = ks.reduce((a, k) => a[k], o); t[last] = v; };

  function openBotModal(index) {
    const isNew = index < 0;
    const src = isNew ? emptyBot() : clone(state.work.projects.bots[index]);
    $('#bot-index').value = String(index);
    $('#bot-modal-title').textContent = isNew ? 'Новый бот' : `Редактирование бота: ${src.name}`;
    const grid = $('#bot-fields'); grid.textContent = '';
    for (const f of BOT_FIELDS) {
      const v = getDot(src, f.k);
      let input;
      if (f.type === 'select') { input = el('select', { 'data-k': f.k }, ...f.options.map(([val, l]) => { const o = el('option', { value: val }, l); if (v === val) o.selected = true; return o; })); }
      else if (f.type === 'textarea' || f.type === 'lines' || f.type === 'pairs') {
        input = el('textarea', { 'data-k': f.k, rows: f.type === 'textarea' ? '3' : '4' });
        input.value = f.type === 'lines' ? (v || []).join('\n') : f.type === 'pairs' ? (v || []).map((sp) => `${sp[0]} ${sp[1]}`.replace(/\s+/, ' ')).join('\n') : (v || '');
        if (f.type === 'pairs') input.value = (v || []).map((sp) => `${sp[0]}: ${sp[1]}`).join('\n');
      } else { input = el('input', { 'data-k': f.k, type: 'text' }); input.value = v || ''; }
      grid.append(el('div', { class: 'field' + (f.full ? ' full' : '') }, el('label', {}, f.label + (f.req ? ' *' : '')), input));
    }
    addUploadButton($('#bot-fields [data-k="screenPreview"]'));
    $('#bot-modal').hidden = false;
  }

  function collectBot() {
    const index = Number($('#bot-index').value);
    const base = index < 0 ? emptyBot() : clone(state.work.projects.bots[index]);
    for (const f of BOT_FIELDS) {
      const raw = $(`#bot-fields [data-k="${f.k}"]`).value;
      let v = raw.trim();
      if (f.type === 'lines') v = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      else if (f.type === 'pairs') v = raw.split('\n').map((s) => { const i = s.indexOf(':'); return i === -1 ? [s.trim(), '—'] : [s.slice(0, i).trim(), s.slice(i + 1).trim() || '—']; }).filter((sp) => sp[0]);
      setDot(base, f.k, v);
    }
    if (!base.catalogSections[1].items.length) base.catalogSections[1].items = ['—'];
    if (!base.blocks[1].items.length) base.blocks[1].items = ['—'];
    if (!base.blocks[2].specs.length) base.blocks[2].specs = [['Статус:', '—']];
    return { index, bot: base };
  }

  $('#bot-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const { index, bot } = collectBot();
    const problems = [];
    // разумные значения по умолчанию для обязательных полей, которые сайт показывает всегда
    if (!bot.screenBadge && /^https:\/\//.test(bot.botUrl)) bot.screenBadge = bot.botUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
    if (!bot.catalogDesc) bot.catalogDesc = bot.lead || '';
    if (!bot.headerTag && bot.name) bot.headerTag = `[ АРХИВ // ${bot.name.toUpperCase()} ]`;
    if (!bot.launchTitle && bot.name) bot.launchTitle = `Запустить бота «${bot.name}» в Telegram`;
    if (!bot.screenAlt && bot.name) bot.screenAlt = `${bot.name} — Telegram-бот`;
    if (!bot.name) problems.push('Укажите название бота.');
    if (!bot.lead) problems.push('Заполните вводный текст досье («Досье: вводный текст»).');
    for (const [k, label] of [['badge', 'бейдж в каталоге'], ['heroStatus', 'статус досье'], ['headerBadge', 'бейдж досье']]) if (!bot[k]) problems.push(`Заполните поле: ${label}.`);
    if (!/^https:\/\//.test(bot.botUrl)) problems.push('Ссылка на бота должна начинаться с https://');
    if (bot.screenPreview && !/^\/previews\/[a-z0-9.-]+\.(jpg|png|webp)$/.test(bot.screenPreview)) problems.push('Превью: путь вида /previews/имя.png (jpg, png или webp).');
    if (problems.length) { alert(problems.join('\n')); return; }
    const projects = state.work.projects;
    if (index < 0) {
      bot.id = ops.uniqueId(projects, bot.name);
      bot.drawerId = ops.uniqueDrawerId(projects, 'modal-' + bot.id);
      bot.cardClass = 'bot-card-' + bot.id;
      bot.type = 'bot';
      projects.bots.push(bot);
    } else {
      projects.bots[index] = bot;
      // если бот стоит в резервной плашке, обновляем её копию
      (projects.slots || []).forEach((s) => { if (s.assigned && (s.assignedProjectId === bot.id || s.project?.id === bot.id)) s.project = clone(bot); });
    }
    markDirty('projects');
    $('#bot-modal').hidden = true;
    render();
  });
  $('#bot-preview-btn').addEventListener('click', () => showPreview('bots', collectBot().bot));
  $('#bot-modal-close').addEventListener('click', () => { $('#bot-modal').hidden = true; });
  $('#bot-cancel-btn').addEventListener('click', () => { $('#bot-modal').hidden = true; });

  function openProjectModal(type, index) {
    $('#pf-type').value = type;
    $('#pf-index').value = String(index);

    let proj = null;
    if (type === 'slot') {
      const slot = state.work.projects.slots[index];
      proj = slot.project || {
        id: slot.slotId,
        name: '',
        badge: 'ПРОЕКТ',
        status: 'published',
        lead: '',
        url: '',
        telegram: '',
        screenPreview: '',
        caption: '',
        blocks: [
          { heading: '// О ПРОЕКТЕ', text: '' },
          { heading: '// КЛЮЧЕВЫЕ МОДУЛИ', items: [] },
          { heading: '// ПАРАМЕТРЫ', specs: [] },
          { heading: '// РЕЗУЛЬТАТ', result: '' },
        ],
      };
      $('#modal-title').textContent = `Назначение проекта: ${slot.slotName}`;
    } else if (type === 'landing') {
      if (index >= 0) {
        proj = state.work.projects.landings[index];
        $('#modal-title').textContent = `Редактирование лендинга: ${proj.name}`;
      } else {
        proj = {
          id: '',
          name: '',
          badge: 'ЛЕНДИНГ',
          status: 'published',
          lead: '',
          url: '',
          telegram: '',
          screenPreview: '',
          caption: '',
          blocks: [
            { heading: '// О ПРОЕКТЕ', text: '' },
            { heading: '// КЛЮЧЕВЫЕ МОДУЛИ', items: [] },
            { heading: '// ПАРАМЕТРЫ', specs: [] },
            { heading: '// РЕЗУЛЬТАТ', result: '' },
          ],
        };
        $('#modal-title').textContent = 'Новый лендинг';
      }
    } else if (type === 'tracker') {
      if (index >= 0) {
        proj = state.work.projects.trackers[index];
        $('#modal-title').textContent = `Редактирование трекера: ${proj.name}`;
      } else {
        proj = {
          id: '',
          name: '',
          badge: 'ТРЕКЕР',
          status: 'published',
          lead: '',
          url: '',
          telegram: '',
          screenPreview: '',
          caption: '',
          blocks: [
            { heading: '// О ТРЕКЕРЕ', text: '' },
            { heading: '// ФУНКЦИОНАЛ', items: [] },
            { heading: '// СТЕК & ПАРАМЕТРЫ', specs: [] },
            { heading: '// РЕЗУЛЬТАТ', result: '' },
          ],
        };
        $('#modal-title').textContent = 'Новый трекер';
      }
    }

    $('#pf-name').value = proj.name || '';
    $('#pf-badge').value = proj.badge || '';
    $('#pf-status').value = proj.status || 'published';
    $('#pf-lead').value = proj.lead || '';
    $('#pf-url').value = proj.url || '';
    $('#pf-telegram').value = proj.telegram || '';
    $('#pf-screen').value = proj.screenPreview || '';
    $('#pf-caption').value = proj.caption || '';

    // Блоки
    const b0 = proj.blocks?.[0] || {};
    $('#pf-block0-head').value = b0.heading || (type === 'tracker' ? '// О ТРЕКЕРЕ' : '// О ПРОЕКТЕ');
    $('#pf-block0-text').value = b0.text || '';

    const b1 = proj.blocks?.[1] || {};
    $('#pf-block1-head').value = b1.heading || (type === 'tracker' ? '// ФУНКЦИОНАЛ' : '// КЛЮЧЕВЫЕ МОДУЛИ');
    $('#pf-block1-items').value = (b1.items || []).join('\n');

    const b2 = proj.blocks?.[2] || {};
    $('#pf-block2-head').value = b2.heading || '// ПАРАМЕТРЫ';
    $('#pf-block2-specs').value = (b2.specs || []).map((sp) => `${sp[0]}: ${sp[1]}`).join('\n');

    const b3 = proj.blocks?.[3] || {};
    $('#pf-block3-head').value = b3.heading || '// РЕЗУЛЬТАТ';
    $('#pf-block3-result').value = b3.result || '';

    // Заполнение выпадающего списка назначения на слоты
    const slotSel = $('#pf-slot-assign');
    if (slotSel) {
      slotSel.textContent = '';
      slotSel.append(el('option', { value: '' }, '— Без привязки к резервной плашке —'));
      const slots = state.work?.projects?.slots || [];
      const currentAssignedSlot = slots.find(s => s.assignedProjectId === proj.id || (s.assigned && s.project?.id === proj.id));
      slots.forEach((s) => {
        const isOccupiedByOther = s.assigned && s.assignedProjectId && s.assignedProjectId !== proj.id;
        const opt = el('option', { value: s.slotId },
          s.slotName + (isOccupiedByOther ? ` (занят: ${s.project?.name || s.assignedProjectId})` : '')
        );
        if (currentAssignedSlot && currentAssignedSlot.slotId === s.slotId) {
          opt.selected = true;
        }
        slotSel.append(opt);
      });
      slotSel.disabled = (type === 'slot');
    }

    addUploadButton($('#pf-screen'));
    $('#project-modal').hidden = false;
  }

  function closeProjectModal() {
    $('#project-modal').hidden = true;
  }

  $('#project-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const type = $('#pf-type').value;
    const index = Number($('#pf-index').value);

    const name = $('#pf-name').value.trim();
    if (!name) return;

    // Сборка блоков
    const defaultBlock0 = type === 'tracker' ? '// О ТРЕКЕРЕ' : '// О ПРОЕКТЕ';
    const defaultBlock1 = type === 'tracker' ? '// ФУНКЦИОНАЛ' : '// КЛЮЧЕВЫЕ МОДУЛИ';
    const block0 = {
      heading: $('#pf-block0-head').value.trim() || defaultBlock0,
      text: $('#pf-block0-text').value.trim(),
    };

    const itemsRaw = $('#pf-block1-items').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const block1 = {
      heading: $('#pf-block1-head').value.trim() || defaultBlock1,
      items: itemsRaw.length ? itemsRaw : ['Модуль в разработке'],
    };

    const specsRaw = $('#pf-block2-specs').value.split('\n').map((s) => {
      const idx = s.indexOf(':');
      if (idx !== -1) return [s.slice(0, idx).trim(), s.slice(idx + 1).trim()];
      return [s.trim(), '—'];
    }).filter((sp) => sp[0]);

    const block2 = {
      heading: $('#pf-block2-head').value.trim() || '// ПАРАМЕТРЫ',
      specs: specsRaw.length ? specsRaw : [['Статус:', 'В работе']],
    };

    const block3 = {
      heading: $('#pf-block3-head').value.trim() || '// РЕЗУЛЬТАТ',
      result: $('#pf-block3-result').value.trim() || 'Проект активен в лаборатории.',
    };

    const projectData = {
      name,
      badge: $('#pf-badge').value.trim() || (type === 'tracker' ? 'ТРЕКЕР' : 'ПРОЕКТ'),
      status: $('#pf-status').value,
      lead: $('#pf-lead').value.trim() || 'Описание проекта в лаборатории.',
      url: $('#pf-url').value.trim(),
      telegram: $('#pf-telegram').value.trim(),
      screenPreview: $('#pf-screen').value.trim(),
      caption: $('#pf-caption').value.trim(),
      blocks: [block0, block1, block2, block3],
    };

    if (type === 'slot') {
      const slot = state.work.projects.slots[index];
      slot.assigned = true;
      projectData.id = slot.assignedProjectId || slot.slotId;
      projectData.headerTag = `[ ПРОЕКТ // ${name.toUpperCase()} ]`;
      slot.project = projectData;
    } else if (type === 'landing') {
      if (index >= 0) {
        const existing = state.work.projects.landings[index];
        projectData.id = existing.id;
        projectData.type = 'landing';
        projectData.drawerId = existing.drawerId || `modal-${existing.id}`;
        projectData.badgeClass = existing.badgeClass || 'badge-blue';
        projectData.screenBadge = existing.screenBadge || projectData.url.replace(/^https?:\/\//, '').replace(/\/$/, '') || name;
        projectData.chipLabel = existing.chipLabel || name;
        projectData.headerTag = `[ ЛЕНДИНГ // ${name.toUpperCase()} ]`;
        projectData.heroStatus = '● ДЕЙСТВУЮЩИЙ ЛЕНДИНГ';
        projectData.desc = projectData.lead;
        state.work.projects.landings[index] = { ...existing, ...projectData };
      } else {
        const id = ops.uniqueId(state.work.projects, name);
        projectData.id = id;
        projectData.type = 'landing';
        projectData.drawerId = ops.uniqueDrawerId(state.work.projects, `modal-${id}`);
        projectData.badgeClass = 'badge-blue';
        projectData.screenBadge = projectData.url.replace(/^https?:\/\//, '').replace(/\/$/, '') || name;
        projectData.chipLabel = name;
        projectData.headerTag = `[ ЛЕНДИНГ // ${name.toUpperCase()} ]`;
        projectData.heroStatus = '● ДЕЙСТВУЮЩИЙ ЛЕНДИНГ';
        projectData.desc = projectData.lead;
        state.work.projects.landings.push(projectData);
      }
    } else if (type === 'tracker') {
      if (index >= 0) {
        const existing = state.work.projects.trackers[index];
        projectData.id = existing.id;
        projectData.type = 'tracker';
        projectData.drawerId = existing.drawerId || `modal-${existing.id}`;
        projectData.badgeClass = existing.badgeClass || 'badge-blue';
        projectData.screenBadge = existing.screenBadge || projectData.url.replace(/^https?:\/\//, '').replace(/\/$/, '') || name;
        projectData.chipLabel = existing.chipLabel || 'TRK';
        projectData.headerTag = `[ ТРЕКЕР // ${name.toUpperCase()} ]`;
        projectData.heroStatus = '● ДЕЙСТВУЮЩИЙ ПРОДУКТ';
        projectData.desc = projectData.lead;
        projectData.catalogBadge = 'ТРЕКЕР';
        projectData.catalogDesc = projectData.lead;
        projectData.urlTitle = existing.urlTitle || `Перейти в ${name}`;
        state.work.projects.trackers[index] = { ...existing, ...projectData };
      } else {
        const id = ops.uniqueId(state.work.projects, name);
        projectData.id = id;
        projectData.type = 'tracker';
        projectData.drawerId = ops.uniqueDrawerId(state.work.projects, `modal-${id}`);
        projectData.badgeClass = 'badge-blue';
        projectData.screenBadge = projectData.url.replace(/^https?:\/\//, '').replace(/\/$/, '') || name;
        projectData.chipLabel = 'TRK';
        projectData.headerTag = `[ ТРЕКЕР // ${name.toUpperCase()} ]`;
        projectData.heroStatus = '● ДЕЙСТВУЮЩИЙ ПРОДУКТ';
        projectData.desc = projectData.lead;
        projectData.catalogBadge = 'ТРЕКЕР';
        projectData.catalogDesc = projectData.lead;
        projectData.urlTitle = `Перейти в ${name}`;
        state.work.projects.trackers.push(projectData);
      }
    }

    // Синхронизация назначения на резервный слот верстака
    if (type !== 'slot' && $('#pf-slot-assign')) {
      const chosenSlotId = $('#pf-slot-assign').value;
      const slots = state.work?.projects?.slots || [];

      // Снимаем этот проект с любых других слотов
      slots.forEach((s) => {
        if (s.assignedProjectId === projectData.id || (s.assigned && s.project?.id === projectData.id)) {
          if (s.slotId !== chosenSlotId) {
            s.assigned = false;
            s.assignedProjectId = null;
            s.project = null;
          }
        }
      });

      // Назначаем на выбранный слот
      if (chosenSlotId) {
        const targetSlot = slots.find((s) => s.slotId === chosenSlotId);
        if (targetSlot) {
          targetSlot.assigned = true;
          targetSlot.assignedProjectId = projectData.id;
          targetSlot.project = clone(projectData);
        }
      }
    }

    markDirty('projects');
    closeProjectModal();
    render();
  });

  // Предпросмотр несохранённых значений формы лендинга/трекера/слота
  $('#pf-preview-btn')?.addEventListener('click', () => {
    const type = $('#pf-type').value;
    const lines = (id) => $(id).value.split('\n').map((x) => x.trim()).filter(Boolean);
    const specs = lines('#pf-block2-specs').map((x) => { const i = x.indexOf(':'); return i === -1 ? [x, '—'] : [x.slice(0, i).trim(), x.slice(i + 1).trim()]; });
    showPreview(type === 'tracker' ? 'trackers' : 'landings', {
      name: $('#pf-name').value.trim(), badge: $('#pf-badge').value.trim(), status: $('#pf-status').value, lead: $('#pf-lead').value.trim(),
      url: $('#pf-url').value.trim(), screenPreview: $('#pf-screen').value.trim(), catalogDesc: $('#pf-lead').value.trim(),
      blocks: [{ heading: $('#pf-block0-head').value.trim(), text: $('#pf-block0-text').value.trim() }, { heading: $('#pf-block1-head').value.trim(), items: lines('#pf-block1-items') },
        { heading: $('#pf-block2-head').value.trim(), specs }, { heading: $('#pf-block3-head').value.trim(), result: $('#pf-block3-result').value.trim() }],
    });
  });
  $('#modal-close-btn').addEventListener('click', closeProjectModal);
  $('#modal-cancel-btn').addEventListener('click', closeProjectModal);

  // ---------- 3.5. ОБРАБОТЧИКИ НАЗНАЧЕНИЯ СЛОТА (ASSIGN MODAL) ----------
  $('#btn-do-assign').addEventListener('click', () => {
    const slotIndex = Number($('#assign-slot-index').value);
    const selVal = $('#assign-project-select').value;
    if (slotIndex < 0 || !selVal) return;

    const [grp, projId] = selVal.split(':');
    const all = [
      ...(state.work.projects.trackers || []).filter((p) => !ops.isArchived(p)).map((p) => ({ ...p, _type: 'tracker' })),
      ...(state.work.projects.landings || []).filter((p) => !ops.isArchived(p)).map((p) => ({ ...p, _type: 'landing' })),
    ];
    const targetProject = all.find((p) => p.id === projId);
    if (!targetProject) return;

    const slot = state.work.projects.slots[slotIndex];
    if (!slot) return;

    // Снимаем этот проект со всех других слотов
    state.work.projects.slots.forEach((s) => {
      if (s.assignedProjectId === targetProject.id || (s.assigned && s.project?.id === targetProject.id)) {
        s.assigned = false;
        s.assignedProjectId = null;
        s.project = null;
      }
    });

    slot.assigned = true;
    slot.assignedProjectId = targetProject.id;
    slot.project = clone(targetProject);
    delete slot.project._type;

    markDirty('projects');
    closeAssignModal();
    render();
  });

  $('#btn-create-for-slot')?.addEventListener('click', () => {
    const slotIndex = Number($('#assign-slot-index').value);
    closeAssignModal();
    if (slotIndex >= 0) {
      openProjectModal('slot', slotIndex);
    }
  });

  $('#btn-cancel-assign').addEventListener('click', closeAssignModal);
  $('#assign-close-btn').addEventListener('click', closeAssignModal);

  // ---------- 4. ПУБЛИКАЦИЯ НА САЙТ (BUILD & VERIFY PIPELINE) ----------
  $('#btn-publish').addEventListener('click', async () => {
    if (state.dirty.size > 0) {
      if (!confirm('Есть несохранённые изменения. Сохранить черновик перед публикацией?')) return;
      for (const f of [...state.dirty]) {
        const { status, body } = await api('/api/save', {
          method: 'POST',
          body: JSON.stringify({ file: f, data: state.work[f], ifMatch: state.etags[f] }),
        });
        if (status === 200) {
          state.data[f] = clone(state.work[f]);
          state.etags[f] = body.etag;
          state.dirty.delete(f);
        } else {
          notice('err', `Не удалось сохранить черновик ${f}.json перед публикацией`);
          return;
        }
      }
      updateToolbar();
    }

    clearNotices();
    const btn = $('#btn-publish');
    const oldText = btn.textContent;
    btn.textContent = '⏳ Сборка dist/...';
    btn.disabled = true;

    try {
      const { status, body } = await api('/api/publish', { method: 'POST' });
      if (status === 200) {
        const lines = [{ message: body.message }, { message: `Время: ${body.timestamp}` }];
        if (body.git) {
          lines.push({ message: body.git.ok
            ? (body.git.changed === false ? 'Git: изменений контента нет' : `Git: коммит ${body.git.commit}${body.git.pushed ? ' отправлен в ветку content' : ' (push выключен)'}`)
            : `Git: не выполнено — ${body.git.error}` });
        }
        notice(body.git && !body.git.ok ? 'warn' : 'ok', body.mode === 'releases' ? '✓ Сайт опубликован (релиз активирован)' : '✓ Проект проверен и собран в dist/', lines);
        if (body.warnings?.length) {
          notice('warn', 'Предупреждения сборки', body.warnings);
        }
        $('#publish-pill').hidden = false;
        $('#publish-pill').textContent = body.release ? 'релиз ' + body.release : 'dist готов (OK)';
      } else if (status === 422) {
        notice('err', 'Публикация отклонена: ошибки валидации данных', body.details || []);
      } else {
        notice('err', 'Ошибка при публикации: ' + (body.error || status));
      }
    } catch (err) {
      notice('err', 'Сетевая ошибка при публикации: ' + err.message);
    } finally {
      btn.textContent = oldText;
      btn.disabled = false;
    }
  });


  // ---------- 6. ИЗОБРАЖЕНИЯ, ЭКСПОРТ И ИМПОРТ ----------
  const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ');

  async function uploadImage(file) {
    if (!file) return { ok: false, error: 'файл не выбран' };
    if (!IMG_TYPES.includes(file.type)) return { ok: false, error: 'допустимы только PNG, JPEG и WebP (SVG запрещён)' };
    if (file.size > 2 * 1024 * 1024) return { ok: false, error: `файл больше 2 МБ (${fmtBytes(file.size)})` };
    try {
      const res = await fetch('/api/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'X-Admin-Token': state.token, 'Content-Type': file.type },
        body: await file.arrayBuffer(),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { showGate('Токен не принят'); return { ok: false, error: 'нет доступа' }; }
      return res.status === 200 ? body : { ok: false, error: body.error || `ошибка ${res.status}` };
    } catch (e) { return { ok: false, error: 'сеть: ' + e.message }; }
  }

  // Кнопка «Загрузить…» рядом с полем пути: выбирает файл, загружает, подставляет путь в поле
  function pickAndUpload(inputEl, onDone) {
    const pick = el('input', { type: 'file', accept: IMG_TYPES.join(',') });
    pick.addEventListener('change', async () => {
      const r = await uploadImage(pick.files[0]);
      if (!r.ok) { alert('Не загружено: ' + r.error); return; }
      inputEl.value = r.path;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      if (onDone) onDone(r);
    });
    pick.click();
  }
  function addUploadButton(inputEl) {
    if (!inputEl || inputEl.parentElement.querySelector('.upload-btn')) return;
    inputEl.parentElement.append(el('button', { type: 'button', class: 'ghost upload-btn', title: 'PNG, JPEG или WebP до 2 МБ', onclick: () => pickAndUpload(inputEl) }, 'Загрузить файл…'));
  }

  async function renderMediaTools(card) {
    const box = el('div', { class: 'media-tools' }, el('h3', {}, 'Изображения (public/previews)'),
      el('p', { class: 'muted small' }, 'Загрузка: PNG, JPEG или WebP до 2 МБ. Тип проверяется по содержимому, метаданные (EXIF, геометки) удаляются, имя файла назначается автоматически. После загрузки вставьте путь в нужное поле.'));
    const result = el('div', { class: 'upload-result muted small' });
    const pick = el('input', { type: 'file', accept: IMG_TYPES.join(','), 'aria-label': 'Выберите изображение' });
    const gallery = el('div', { class: 'media-gallery' });
    const refresh = async () => {
      gallery.textContent = '';
      const { status, body } = await api('/api/media');
      if (status !== 200) { gallery.append(el('p', { class: 'muted' }, 'Список недоступен')); return; }
      if (!body.files.length) gallery.append(el('p', { class: 'muted' }, 'Файлов пока нет.'));
      for (const f of body.files) {
        gallery.append(el('div', { class: 'media-item' },
          el('img', { src: f.path, alt: f.name, loading: 'lazy' }),
          el('div', { class: 'media-name', title: f.path }, f.path),
          el('div', { class: 'muted small' }, fmtBytes(f.bytes)),
          el('button', { type: 'button', class: 'ghost', onclick: async () => { try { await navigator.clipboard.writeText(f.path); result.textContent = 'Путь скопирован: ' + f.path; } catch { result.textContent = 'Путь: ' + f.path; } } }, 'Копировать путь')));
      }
    };
    pick.addEventListener('change', async () => {
      result.textContent = 'Загрузка…';
      const r = await uploadImage(pick.files[0]);
      pick.value = '';
      result.textContent = r.ok ? `Загружено: ${r.path} (${r.width}×${r.height}, ${fmtBytes(r.bytes)}${r.cleaned ? ', метаданные удалены' : ''})` : 'Не загружено: ' + r.error;
      result.classList.toggle('err', !r.ok);
      if (r.ok) refresh();
    });
    box.append(pick, result, gallery);
    card.append(box);
    refresh();
  }

  async function doExport() {
    const res = await fetch('/api/export', { headers: { 'X-Admin-Token': state.token } });
    if (res.status !== 200) { notice('err', 'Экспорт не выполнен', [{ message: 'ошибка ' + res.status }]); return; }
    const blob = await res.blob();
    const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const a = el('a', { href: URL.createObjectURL(blob), download: m ? m[1] : 'gonka-blog-content.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    notice('ok', 'Экспорт выполнен', [{ message: 'Файл содержит только данные контента (без изображений). Хранится у вас — храните как резервную копию.' }]);
  }

  async function doImport(file) {
    clearNotices();
    let bundle;
    try { bundle = JSON.parse(await file.text()); } catch { notice('err', 'Файл не разобран', [{ message: 'это не корректный JSON' }]); return; }
    const post = (dry) => api('/api/import?dryRun=' + (dry ? '1' : '0'), { method: 'POST', body: JSON.stringify({ bundle }) });
    const dry = await post(true);
    if (dry.status !== 200) { notice('err', 'Импорт отклонён — данные не изменены', dry.body?.errors || [{ message: dry.body?.error || 'ошибка ' + dry.status }]); return; }
    if (!dry.body.changed.length) { notice('ok', 'Импорт: изменений нет', [{ message: 'Данные в файле совпадают с текущими.' }]); return; }
    const unsaved = state.dirty.size ? '\n\nВНИМАНИЕ: несохранённые правки в редакторе будут потеряны.' : '';
    if (!confirm(`Импорт заменит данные: ${dry.body.changed.join(', ')}.\nПеред записью для каждого файла создаётся резервная копия (вкладка «История»).${unsaved}\n\nПродолжить?`)) { notice('warn', 'Импорт отменён'); return; }
    const real = await post(false);
    if (real.status !== 200) { notice('err', 'Импорт не выполнен', real.body?.errors || [{ message: real.body?.error || 'ошибка ' + real.status }]); return; }
    await load();
    notice('ok', 'Импорт выполнен', [{ message: 'Обновлено: ' + real.body.changed.join(', ') }, ...(real.body.warnings || []).slice(0, 5)]);
  }

  $('#btn-export')?.addEventListener('click', doExport);
  $('#btn-import')?.addEventListener('click', () => $('#import-file').click());
  $('#import-file')?.addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await doImport(f); });

  // ---------- 5. СТАНДАРТНЫЙ РЕДАКТОР СУЩЕСТВУЮЩЕГО КОНТЕНТА ----------
  function field(label, value, onInput) {
    const ta = el('textarea', { rows: value.length > 80 || value.includes('\n') ? 4 : 2 });
    ta.value = value;
    ta.addEventListener('input', () => onInput(ta.value));
    return el('div', { class: 'field' }, el('label', {}, label), ta);
  }

  const DESK_LABELS = {
    'modal-incoming': 'modal-incoming (Телефон // Прямая линия)',
    'modal-draft': 'modal-draft (Блокнот // Черновик)',
    'modal-failures': 'modal-failures (Папка // Архив ошибок)',
    'modal-core': 'modal-core (Центр верстака // Система)',
    'modal-video': 'modal-video (Киноплёнка // Видео)',
    'modal-network': 'modal-network (Карта связей // Инструменты)',
    'modal-srbija': 'modal-srbija (Резная плашка SRBIJA — проект Reloca)',
    'modal-trackers': 'modal-trackers (Плашка ТАСК-ТРЕКЕРЫ справа внизу стола)',
    'modal-manifesto': 'modal-manifesto (Кружка // IDEAS BUILD TEST REPEAT)',
  };

  function renderValue(key, value, path, container, file) {
    if (typeof value === 'string') {
      let fieldLabel = key;
      if (file === 'site' && path.length === 2 && path[0] === 'desk') {
        if (key === 'tag') fieldLabel = 'Надпись на плашке (tag)';
        else if (key === 'statement') fieldLabel = 'Слоган / цитата (statement)';
      }
      container.append(field(fieldLabel, value, (v) => {
        setPath(state.work[file], path, v);
        markDirty(file);
      }));
      return;
    }
    if (Array.isArray(value)) {
      const box = el('div', { class: 'arr' });
      box.append(el('div', { class: 'arr-head' },
        `${key} — ${value.length} элем.`));
      value.forEach((item, i) => {
        renderValue(`[${i}]`, item, [...path, i], box, file);
      });
      container.append(box);
      return;
    }
    if (value && typeof value === 'object') {
      const box = el('div', { class: 'obj' });
      let displayKey = key;
      if (file === 'site' && path.length === 1 && path[0] === 'desk' && DESK_LABELS[key]) {
        displayKey = DESK_LABELS[key];
      }
      if (key) box.append(el('div', { class: 'obj-key' }, displayKey));
      for (const [k, v] of Object.entries(value)) {
        renderValue(k, v, [...path, k], box, file);
      }
      container.append(box);
      return;
    }
    if (typeof value === 'boolean') {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = value;
      cb.addEventListener('change', () => { setPath(state.work[file], path, cb.checked); markDirty(file); });
      container.append(el('div', { class: 'field' }, el('label', {}, key), cb));
      return;
    }
    if (typeof value === 'number') {
      const num = el('input', { type: 'number', step: '1' });
      num.value = String(value);
      num.addEventListener('input', () => { if (num.value !== '' && Number.isFinite(Number(num.value))) { setPath(state.work[file], path, Number(num.value)); markDirty(file); } });
      container.append(el('div', { class: 'field' }, el('label', {}, key), num));
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
      if (file === 'media') renderMediaTools(card);
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
    const file = fileOfTab(state.tab);
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
    const file = fileOfTab(state.tab);
    if (file === 'site' && state.work?.site?.desk?.['modal-serbia-wip']) {
      if (!state.work.site.desk['modal-trackers']) {
        state.work.site.desk['modal-trackers'] = {
          tag: state.work.site.desk['modal-serbia-wip'].tag || 'ТАСК-ТРЕКЕРЫ',
          statement: state.work.site.desk['modal-serbia-wip'].statement || '«Внутренние рабочие инструменты и таск-трекеры.»',
        };
      } else if (state.work.site.desk['modal-serbia-wip'].tag) {
        state.work.site.desk['modal-trackers'].tag = state.work.site.desk['modal-serbia-wip'].tag;
      }
      if (!state.work.site.desk['modal-srbija']) {
        state.work.site.desk['modal-srbija'] = {
          tag: 'SRBIJA',
          statement: '«Полевое исследование и личный R&D.»',
        };
      }
      delete state.work.site.desk['modal-serbia-wip'];
    }
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
      if (body.warnings?.length) notice('warn', 'Черновик сохранён с предупреждениями', body.warnings);
      else notice('ok', 'Черновик успешно сохранён', [{ message: `бэкап: ${body.backup}` }]);
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

  // ---------- main render router ----------
  function render() {
    const isHistory = state.tab === 'history';
    const PROJECT_TABS = ['landings', 'trackers', 'bots'];
    const isSlots = state.tab === 'slots';
    const isProjects = PROJECT_TABS.includes(state.tab);
    const isFile = !isHistory && !isSlots && !isProjects;

    $('#editor').hidden = !isFile;
    $('#history').hidden = !isHistory;
    $('#slots-view').hidden = !isSlots;
    for (const g of PROJECT_TABS) $(VIEW[g]).hidden = state.tab !== g;
    $('#diffbox').hidden = true;

    if (isHistory) renderHistory();
    else if (isSlots) renderSlots();
    else if (isProjects) renderProjects(state.tab);
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
    if (!ok && state.token && !state.versionError) showGate('Токен не принят (проверьте tools/admin/.token)');
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

  window.addEventListener('beforeunload', (e) => { if (state.dirty.size) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- start ----------
  (async () => {
    if (!state.token) { showGate(); return; }
    const ok = await load().catch(() => false);
    if (!ok && state.token && !state.versionError) showGate('Сессия истекла или токен неверен');
    else showConnection(true, 'localhost:' + (location.port || '80'));
  })();
})();
