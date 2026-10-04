// tools/admin/lib/project-ops.mjs — операции над проектами (лендинги, трекеры, боты) в projects.json.
// Чистые функции без DOM, сети и файловой системы: используются и интерфейсом админки (/ui/project-ops.mjs), и сервером, и тестами.
// Функции изменяют переданный объект projects НА МЕСТЕ (интерфейс передаёт рабочую копию) и возвращают {ok, ...}.

export const GROUPS = ['landings', 'trackers', 'bots'];
export const TYPE_OF = { landings: 'landing', trackers: 'tracker', bots: 'bot' };
export const GROUP_LABEL = { landings: 'Лендинги', trackers: 'Трекеры', bots: 'Боты' };
export const STATUSES = ['published', 'draft', 'hidden', 'archived'];
export const STATUS_LABEL = { published: 'Опубликован', draft: 'Черновик', hidden: 'Скрыт', archived: 'В архиве' };

const clone = (v) => JSON.parse(JSON.stringify(v));
export const isArchived = (p) => !!p && p.status === 'archived';

export function slugify(text) {
  const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
  const s = String(text || '').toLowerCase().split('').map((ch) => (ch in map ? map[ch] : ch)).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'project';
}

export function allProjects(projects) {
  const out = [];
  for (const group of GROUPS) (projects[group] || []).forEach((item, index) => out.push({ group, index, item }));
  return out;
}

// id панели, которую шаблон строит для проекта
export function drawerIdOf(group, item) {
  if (item.drawerId) return item.drawerId;
  if (group === 'landings') return 'modal-landing-' + item.id;
  if (group === 'trackers') return 'modal-' + item.id;
  return undefined;
}

export function findProject(projects, group, id) {
  const index = (projects[group] || []).findIndex((p) => p.id === id);
  return index === -1 ? null : { index, item: projects[group][index] };
}

// Уникальный id среди всех групп и id слотов; уникальность drawerId проверяется отдельно
export function uniqueId(projects, base) {
  const used = new Set([...allProjects(projects).map((x) => x.item.id), ...(projects.slots || []).map((s) => s.slotId)]);
  const root = slugify(base);
  if (!used.has(root)) return root;
  for (let n = 2; n < 1000; n++) if (!used.has(`${root}-${n}`)) return `${root}-${n}`;
  return `${root}-${Date.now().toString(36)}`;
}

function usedDrawerIds(projects) {
  return new Set(allProjects(projects).map((x) => drawerIdOf(x.group, x.item)).filter(Boolean));
}

export function uniqueDrawerId(projects, preferred) {
  const used = usedDrawerIds(projects);
  if (!used.has(preferred)) return preferred;
  for (let n = 2; n < 1000; n++) if (!used.has(`${preferred}-${n}`)) return `${preferred}-${n}`;
  return `${preferred}-${Date.now().toString(36)}`;
}

function slotOf(projects, id) {
  return (projects.slots || []).find((s) => s.assignedProjectId === id || (s.assigned && s.project?.id === id)) || null;
}

function clearSlot(slot) {
  slot.assigned = false; slot.assignedProjectId = null; slot.project = null;
}

// ---- архив / восстановление / дублирование / удаление ----

export function archiveProject(projects, group, id, nowIso = new Date().toISOString()) {
  const f = findProject(projects, group, id);
  if (!f) return { ok: false, error: 'проект не найден' };
  if (isArchived(f.item)) return { ok: false, error: 'проект уже в архиве' };
  const slot = slotOf(projects, id);
  f.item.prevStatus = f.item.status;
  f.item.status = 'archived';
  f.item.archivedAt = nowIso;
  if (slot) { f.item.archivedSlotId = slot.slotId; clearSlot(slot); } // с сайта убираем и копию в слоте; восстановление вернёт её, если слот свободен
  return { ok: true, slotCleared: slot ? slot.slotId : null };
}

export function restoreProject(projects, group, id) {
  const f = findProject(projects, group, id);
  if (!f) return { ok: false, error: 'проект не найден' };
  if (!isArchived(f.item)) return { ok: false, error: 'проект не в архиве' };
  const p = f.item;
  p.status = ['published', 'draft', 'hidden'].includes(p.prevStatus) ? p.prevStatus : 'draft';
  let restoredSlot = null, slotBusy = null;
  if (p.archivedSlotId) {
    const slot = (projects.slots || []).find((s) => s.slotId === p.archivedSlotId);
    if (slot && !slot.assigned) {
      const copy = clone(p);
      for (const k of ['prevStatus', 'archivedAt', 'archivedSlotId']) delete copy[k];
      slot.assigned = true; slot.assignedProjectId = p.id; slot.project = copy; restoredSlot = slot.slotId;
    } else if (slot) slotBusy = slot.slotId;
  }
  for (const k of ['prevStatus', 'archivedAt', 'archivedSlotId']) delete p[k];
  return { ok: true, status: p.status, restoredSlot, slotBusy };
}

export function duplicateProject(projects, group, id) {
  const f = findProject(projects, group, id);
  if (!f) return { ok: false, error: 'проект не найден' };
  const copy = clone(f.item);
  for (const k of ['prevStatus', 'archivedAt', 'archivedSlotId']) delete copy[k];
  copy.id = uniqueId(projects, `${f.item.id}-copy`);
  copy.name = `${f.item.name} (копия)`;
  copy.status = 'draft';                                  // копия никогда не публикуется сама
  if (group === 'landings') copy.drawerId = uniqueDrawerId(projects, 'modal-landing-' + copy.id);
  else copy.drawerId = uniqueDrawerId(projects, 'modal-' + copy.id);
  if (copy.chipLabel && group === 'landings') copy.chipLabel = f.item.chipLabel;
  projects[group].splice(f.index + 1, 0, copy);           // сразу после оригинала; слоты не копируются
  return { ok: true, id: copy.id, index: f.index + 1 };
}

// Окончательное удаление — только из архива
export function deleteForever(projects, group, id) {
  const f = findProject(projects, group, id);
  if (!f) return { ok: false, error: 'проект не найден' };
  if (!isArchived(f.item)) return { ok: false, error: 'окончательно удалить можно только проект из архива' };
  const slot = slotOf(projects, id);
  if (slot) clearSlot(slot);
  const [removed] = projects[group].splice(f.index, 1);
  return { ok: true, removed };
}

// ---- поиск и фильтрация ----
// status: 'active' (всё, кроме архива) | 'all' | конкретный статус
export function searchProjects(projects, { q = '', group = 'all', status = 'active' } = {}) {
  const needle = String(q).trim().toLowerCase();
  return allProjects(projects).filter(({ group: g, item }) => {
    if (group !== 'all' && g !== group) return false;
    if (status === 'active' ? isArchived(item) : status !== 'all' && item.status !== status) return false;
    if (!needle) return true;
    const hay = [item.id, item.name, item.badge, item.lead, item.catalogDesc, item.desc, item.url, item.botUrl, item.telegram, item.screenBadge, item.headerTag]
      .filter((x) => typeof x === 'string').join(' ').toLowerCase();
    return hay.includes(needle);
  });
}

// ---- целостность ----
export function checkIntegrity(projects) {
  const errors = [], warnings = [];
  const ids = new Map(), drawers = new Map();
  for (const { group, index, item } of allProjects(projects)) {
    const at = `${group}[${index}]`;
    if (ids.has(item.id)) errors.push({ path: `${at}.id`, message: `повторяющийся id «${item.id}» (также в ${ids.get(item.id)})` });
    ids.set(item.id, at);
    const d = drawerIdOf(group, item);
    if (d) {
      if (drawers.has(d)) errors.push({ path: `${at}.drawerId`, message: `повторяющийся id панели «${d}» (также в ${drawers.get(d)})` });
      drawers.set(d, at);
      if (!/^modal-[a-z0-9-]+$/.test(d)) errors.push({ path: `${at}.drawerId`, message: 'id панели: только modal-[a-z0-9-]' });
    }
    if (!STATUSES.includes(item.status)) errors.push({ path: `${at}.status`, message: `неизвестный статус «${item.status}»` });
    if (isArchived(item) && !item.archivedAt) warnings.push({ path: `${at}.archivedAt`, message: 'у проекта в архиве нет даты архивации' });
    if (!isArchived(item) && (item.archivedAt || item.prevStatus || item.archivedSlotId)) warnings.push({ path: at, message: 'служебные поля архива остались у активного проекта' });
    if (item.status === 'published' && !item.name) errors.push({ path: `${at}.name`, message: 'у опубликованного проекта нет названия' });
  }
  const slotIds = new Set();
  (projects.slots || []).forEach((s, i) => {
    const at = `slots[${i}]`;
    if (slotIds.has(s.slotId)) errors.push({ path: `${at}.slotId`, message: `повторяющийся слот «${s.slotId}»` });
    slotIds.add(s.slotId);
    if (!s.assigned) return;
    const refId = s.assignedProjectId || s.project?.id;
    const src = refId ? allProjects(projects).find((x) => x.item.id === refId) : null;
    if (s.assignedProjectId && !src) { warnings.push({ path: `${at}.assignedProjectId`, message: `слот ссылается на проект «${s.assignedProjectId}», которого нет в каталогах` }); return; }
    if (src && isArchived(src.item)) errors.push({ path: `${at}.assignedProjectId`, message: `в слоте стоит проект «${src.item.name}», который находится в архиве` });
    else if (src && s.project) {
      const strip = (o) => { const c = clone(o); for (const k of ['prevStatus', 'archivedAt', 'archivedSlotId']) delete c[k]; return JSON.stringify(c); };
      if (strip(src.item) !== strip(s.project)) warnings.push({ path: `${at}.project`, message: `копия проекта «${src.item.name}» в слоте «${s.slotName || s.slotId}» отличается от каталога (откройте проект и сохраните его, чтобы обновить слот)` });
    }
  });
  return { errors, warnings };
}

// Защита от случайной потери: проекты, исчезнувшие из нового состояния, должны были уже быть в архиве.
export function findUnarchivedRemovals(prev, next) {
  const nextIds = new Set(allProjects(next).map((x) => x.item.id));
  return allProjects(prev).filter(({ item }) => !nextIds.has(item.id) && !isArchived(item)).map(({ group, item }) => ({ group, id: item.id, name: item.name }));
}
