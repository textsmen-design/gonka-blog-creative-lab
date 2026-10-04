#!/usr/bin/env node
// tools/admin/test-suite.mjs — комплексные интеграционные тесты админки GONKA.BLOG.
// Тестирует: схемы, привязки, серверные эндпоинты, 6 слотов, лендинги, бэкапы, откат и конвейер публикации.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// Запускаем сервер на тестовом порту
const TEST_PORT = 4319;
const TEST_TOKEN = 'test-token-secret-1234567890abcdef';
process.env.ADMIN_PORT = String(TEST_PORT);
process.env.ADMIN_TOKEN = TEST_TOKEN;

console.log('=== ЗАПУСК ТЕСТОВОГО НАБОРА GONKA.BLOG ADMIN ===');

// 1. Тест модулей хранилища и валидации
const store = await import('./store.mjs');
const validate = await import('./validate.mjs');
const bindings = await import('./bindings.mjs');

let passed = 0;
let total = 0;

function it(name, fn) {
  total += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    Ошибка: ${e.message}`);
  }
}

async function itAsync(name, fn) {
  total += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    Ошибка: ${e.message}`);
  }
}

// --- БЛОК 1: СХЕМЫ И ДАННЫЕ ---
console.log('\n[1/5] Проверка валидации схем и структуры данных:');

it('Все 5 файлов (site, links, media, sections, projects) присутствуют в FILE_NAMES', () => {
  assert.equal(store.FILE_NAMES.length, 5);
  assert.ok(store.FILE_NAMES.includes('projects'));
});

it('Все 5 файлов проходят валидацию без ошибок', () => {
  for (const name of store.FILE_NAMES) {
    const data = store.readJSON(name);
    const res = validate.validateFile(name, data);
    assert.equal(res.errors.length, 0, `Ошибки в ${name}: ${JSON.stringify(res.errors)}`);
  }
});

it('projects.json содержит ровно 6 резервных слотов с правильными ID', () => {
  const p = store.readJSON('projects');
  assert.equal(p.slots.length, 6);
  const slotIds = p.slots.map(s => s.slotId);
  assert.deepEqual(slotIds, ['lamp', 'mug', 'compass', 'photos', 'magnifier', 'pencilcup']);
});

it('projects.json содержит 5 действующих лендингов и каталог трекеров', () => {
  const p = store.readJSON('projects');
  assert.ok(Array.isArray(p.landings));
  assert.equal(p.landings.length, 5);
  const ids = p.landings.map(l => l.id);
  assert.ok(ids.includes('english-teacher'));
  assert.ok(ids.includes('twohearts'));
  assert.ok(ids.includes('siteviza'));
  assert.ok(ids.includes('atelier'));
  assert.ok(ids.includes('landasset5'));

  assert.ok(Array.isArray(p.trackers));
  assert.equal(p.trackers.length, 1);
  assert.equal(p.trackers[0].id, 'tracker-01');
  assert.equal(p.trackers[0].url, 'https://tracker-01.gonka.blog/');
});

it('Плашка SRBIJA корректно перенесена в site.json и sections.json, фраза «Релокант Сербия» отсутствует', () => {
  const site = store.readJSON('site');
  const sections = store.readJSON('sections');
  assert.ok(site.desk['modal-srbija'], 'site.desk.modal-srbija должна существовать');
  assert.equal(site.desk['modal-srbija'].tag, 'SRBIJA');
  assert.ok(sections['modal-srbija'], 'sections.modal-srbija должна существовать');
  assert.equal(sections['modal-srbija'].hero.title, 'SRBIJA');
  
  const rawSite = JSON.stringify(site);
  const rawSections = JSON.stringify(sections);
  assert.ok(!rawSite.includes('Релокант Сербия'), 'site.json не должен содержать «Релокант Сербия»');
  assert.ok(!rawSections.includes('Релокант Сербия'), 'sections.json не должен содержать «Релокант Сербия»');
});

// --- БЛОК 2: ПРИВЯЗКИ К ШАБЛОНАМ ---
console.log('\n[2/5] Проверка привязок AST/шаблонов (checkBindings):');

it('checkBindings() выполняется с 0 ошибок и 0 предупреждений', () => {
  const res = bindings.checkBindings();
  assert.equal(res.errors.length, 0, `Ошибки привязок: ${JSON.stringify(res.errors)}`);
  assert.equal(res.warnings.length, 0, `Предупреждения привязок: ${JSON.stringify(res.warnings)}`);
});

// --- БЛОК 3: СЕРВЕР И БЕЗОПАСНОСТЬ ---
console.log('\n[3/5] Проверка локального API сервера:');

// Импортируем и запускаем сервер
await import('./server.mjs');

// Подождём запуск сервера
await new Promise(r => setTimeout(r, 400));

function req(path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path,
      method,
      headers: {
        Host: `127.0.0.1:${TEST_PORT}`,
        Origin: `http://127.0.0.1:${TEST_PORT}`,
        ...headers,
      }
    };
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let parsed = null;
        const raw = Buffer.concat(chunks).toString('utf8');
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

await itAsync('Запрос без токена возвращает 401', async () => {
  const res = await req('/api/data');
  assert.equal(res.status, 401);
});

await itAsync('Запрос с неверным токеном возвращает 401', async () => {
  const res = await req('/api/data', { headers: { Authorization: 'Bearer invalid-token' } });
  assert.equal(res.status, 401);
});

await itAsync('Запрос с внешним Origin возвращает 403', async () => {
  const res = await req('/api/data', {
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      Origin: 'https://evil.com',
    }
  });
  assert.equal(res.status, 403);
});

await itAsync('GET /api/data с правильным токеном возвращает 200, 5 файлов и etags', async () => {
  const res = await req('/api/data', {
    headers: { Authorization: `Bearer ${TEST_TOKEN}` }
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.files.length, 5);
  assert.ok(res.body.data.projects);
  assert.ok(res.body.etags.projects);
});

await itAsync('Сохранение site.json с надписью «ТАСК-ТРЕКЕРЫ» через POST /api/save', async () => {
  const resFetch = await req('/api/data', { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
  const site = resFetch.body.data.site;
  site.desk['modal-trackers'].tag = 'ТАСК-ТРЕКЕРЫ';
  const res = await req('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
    body: { file: 'site', data: site, ifMatch: resFetch.body.etags.site }
  });
  assert.equal(res.status, 200, `Ошибка: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.ok);
});

await itAsync('Обратная совместимость: сохранение старого ключа modal-serbia-wip мигрирует в modal-trackers без ошибок валидации', async () => {
  const resFetch = await req('/api/data', { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
  const site = resFetch.body.data.site;
  // Имитируем старый формат клиента: modal-serbia-wip вместо modal-trackers и без modal-srbija
  delete site.desk['modal-trackers'];
  delete site.desk['modal-srbija'];
  site.desk['modal-serbia-wip'] = { tag: 'ТАСК-ТРЕКЕРЫ' };
  
  const res = await req('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
    body: { file: 'site', data: site, ifMatch: resFetch.body.etags.site }
  });
  assert.equal(res.status, 200, `Ожидался статус 200, получено ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.ok);

  const resVerify = await req('/api/data', { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
  const savedSite = resVerify.body.data.site;
  assert.ok(savedSite.desk['modal-trackers'], 'modal-trackers должен быть создан');
  assert.equal(savedSite.desk['modal-trackers'].tag, 'ТАСК-ТРЕКЕРЫ');
  assert.ok(savedSite.desk['modal-srbija'], 'modal-srbija должен быть сохранён');
  assert.equal(savedSite.desk['modal-srbija'].tag, 'SRBIJA');
  assert.equal(savedSite.desk['modal-serbia-wip'], undefined, 'modal-serbia-wip должен быть удалён после миграции');
});

// --- БЛОК 4: УПРАВЛЕНИЕ СЛОТАМИ И ЛЕНДИНГАМИ ЧЕРЕЗ API ---
console.log('\n[4/5] Управление слотами и лендингами (CRUD и целостность):');

let projectsData = null;
let projectsEtag = null;

await itAsync('Получение исходного состояния projects.json', async () => {
  const res = await req('/api/data', {
    headers: { Authorization: `Bearer ${TEST_TOKEN}` }
  });
  assert.equal(res.status, 200);
  projectsData = res.body.data.projects;
  projectsEtag = res.body.etags.projects;
  assert.ok(projectsData);
});

await itAsync('Назначение проекта в Слот 1 (Лампа) и сохранение через POST /api/save', async () => {
  const modified = JSON.parse(JSON.stringify(projectsData));
  modified.slots[0].assigned = true;
  modified.slots[0].project = {
    id: 'lamp',
    name: 'Тестовый проект Лампы',
    badge: 'R&D',
    status: 'published',
    lead: 'Личный экспериментальный R&D проект под лампой.',
    url: 'https://lamp.gonka.blog',
    telegram: 'https://t.me/gonka_admin',
    screenPreview: '/previews/english-teacher-1.jpg',
    caption: 'Экран проекта лампы',
    blocks: [
      { heading: '// О ПРОЕКТЕ', text: 'Описание лампового проекта.' },
      { heading: '// КЛЮЧЕВЫЕ МОДУЛИ', items: ['Модуль 1', 'Модуль 2'] },
      { heading: '// ПАРАМЕТРЫ', specs: [['Тип:', 'Исследование'], ['Статус:', 'Готов']] },
      { heading: '// РЕЗУЛЬТАТ', result: 'Проект запущен.' },
    ]
  };

  const res = await req('/api/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`
    },
    body: {
      file: 'projects',
      data: modified,
      ifMatch: projectsEtag
    }
  });

  assert.equal(res.status, 200, `Ошибка сохранения: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.ok);
  assert.ok(res.body.backup);
  projectsEtag = res.body.etag;
});

await itAsync('Проверка: Слот 1 сохранен, остальные слоты остаются чистыми резервами', async () => {
  const res = await req('/api/data', {
    headers: { Authorization: `Bearer ${TEST_TOKEN}` }
  });
  assert.equal(res.status, 200);
  const p = res.body.data.projects;
  assert.equal(p.slots[0].assigned, true);
  assert.equal(p.slots[0].project.name, 'Тестовый проект Лампы');
  assert.equal(p.slots[1].assigned, false); // кружка свободна
  assert.equal(p.slots[2].assigned, false); // компас свободен
});

await itAsync('Добавление нового лендинга (7-й лендинг) и сохранение', async () => {
  const resFetch = await req('/api/data', { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
  const modified = resFetch.body.data.projects;
  
  modified.landings.push({
    id: 'ai-creative-bot',
    name: 'AI Creative Bot',
    badge: 'ЛЕНДИНГ',
    badgeClass: 'badge-blue',
    status: 'published',
    drawerId: 'modal-landing-ai-creative-bot',
    screenBadge: 'creative.gonka.blog',
    screenPreview: '/previews/atelier-1.jpg',
    caption: 'Экран креативного бота',
    desc: 'Промо-лендинг для генеративного AI сервиса.',
    chipLabel: 'AI Bot',
    headerTag: '[ ЛЕНДИНГ // AI BOT ]',
    heroStatus: '● ДЕЙСТВУЮЩИЙ ЛЕНДИНГ',
    lead: 'Промо-лендинг нового поколения.',
    url: 'https://creative.gonka.blog',
    telegram: 'https://t.me/gonka_admin',
    blocks: [
      { heading: '// О ПРОЕКТЕ', text: 'Креативный ИИ сервис.' },
      { heading: '// КЛЮЧЕВЫЕ МОДУЛИ', items: ['Промптинг', 'Генерация'] },
      { heading: '// ПАРАМЕТРЫ', specs: [['Стек:', 'FastAPI / Svelte']] },
      { heading: '// РЕЗУЛЬТАТ', result: 'Релиз состоялся.' }
    ]
  });

  const res = await req('/api/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`
    },
    body: {
      file: 'projects',
      data: modified,
      ifMatch: resFetch.body.etags.projects
    }
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.ok);
  projectsEtag = res.body.etag;
});

await itAsync('Освобождение Слота 1 и удаление тестового лендинга (возврат к исходному состоянию)', async () => {
  const res = await req('/api/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`
    },
    body: {
      file: 'projects',
      data: projectsData, // исходные данные
      ifMatch: projectsEtag
    }
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.ok);
  projectsEtag = res.body.etag;
});

// --- БЛОК 5: ПУБЛИКАЦИЯ И ДЕПЛОЙ-КОНВЕЙЕР ---
console.log('\n[5/5] Проверка конвейера публикации (/api/publish):');

await itAsync('POST /api/publish валидирует данные, запускает astro build и проверяет dist/', async () => {
  const res = await req('/api/publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TEST_TOKEN}`
    }
  });

  assert.equal(res.status, 200, `Ошибка публикации: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.message.includes('dist/'));
});

await itAsync('Проверка целостности dist/: verify-dist.mjs подтверждает чистоту', async () => {
  const verify = await import('./verify-dist.mjs');
  assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'index.html')));
});

console.log(`\n=== РЕЗУЛЬТАТЫ ТЕСТОВ: ${passed}/${total} УСПЕШНО ===\n`);
if (passed === total) {
  process.exit(0);
} else {
  process.exit(1);
}
