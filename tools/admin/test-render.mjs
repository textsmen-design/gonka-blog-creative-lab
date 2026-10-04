#!/usr/bin/env node
// tools/admin/test-render.mjs — e2e на временной копии проекта: изменения данных (scene/links/projects) → сборка → HTML.
// Проверяет, что правки из админки реально попадают на публичную страницу (и скрытое — исчезает). Реальные файлы не трогает.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ops = await import('./lib/project-ops.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gonka-render-'));
const cp = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(tmp, rel), { recursive: true, filter: (s) => !s.includes('.backups') && !s.includes('.tmp') });
for (const rel of ['src', 'astro.config.mjs', 'package.json', 'tsconfig.json', 'public/scene']) cp(rel);
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const data = (n) => path.join(tmp, 'src', 'data', n + '.json');
const readJ = (n) => JSON.parse(fs.readFileSync(data(n), 'utf8'));
const writeJ = (n, v) => fs.writeFileSync(data(n), JSON.stringify(v, null, 2) + '\n');
const build = (out) => { execFileSync('npx', ['astro', 'build', '--outDir', out], { cwd: tmp, stdio: 'ignore' }); return fs.readFileSync(path.join(out, 'index.html'), 'utf8'); };

try {
  const h0 = build(path.join(tmp, 'out0'));
  check('базовая сборка: 15 предметов, 4 соцсети, 2 бота в каталоге', (h0.match(/class="scene-obj /g) || []).length === 15 && (h0.match(/class="scene-social"[\s\S]*?<\/div>/)[0].match(/<a /g) || []).length === 4 && (h0.match(/class="catalog-project-card bot-card/g) || []).length === 2);

  const sc = readJ('scene'); sc.items[2].visible = false; sc.items[0].label = 'Лампа ТЕСТ-ПОДПИСЬ'; writeJ('scene', sc);
  const links = readJ('links'); links.socials[3].enabled = false; links.socials[0].url = 'https://t.me/test_render_user'; writeJ('links', links);
  const pr = readJ('projects'); pr.bots[1].status = 'draft';
  pr.bots.push({ ...JSON.parse(JSON.stringify(pr.bots[0])), id: 'bot-three', drawerId: 'modal-bot-three', name: 'Третий бот ТЕСТ', cardClass: 'bot-card-meat', status: 'published', botUrl: 'https://t.me/third_test_bot' }); writeJ('projects', pr);
  const h1 = build(path.join(tmp, 'out1'));
  check('скрытый предмет (visible:false) исчез со сцены', (h1.match(/class="scene-obj /g) || []).length === 14 && !h1.includes('data-obj="camera"'));
  check('подпись предмета из scene.json попала в aria-label', h1.includes('Резервный слот: Лампа ТЕСТ-ПОДПИСЬ'));
  check('отключённая соцсеть (instagram) исчезла из значков', !/Instagram профиль/.test(h1.match(/class="scene-social"[\s\S]*?<\/div>/)[0]));
  check('URL соцсети из links.socials попал в значок и в кнопки разделов', h1.includes('href="https://t.me/test_render_user"') && (h1.match(/https:\/\/t\.me\/test_render_user/g) || []).length > 5, String((h1.match(/https:\/\/t\.me\/test_render_user/g) || []).length));
  check('бот-черновик скрыт из каталога', !h1.includes('bot-card-detective'));
  check('новый бот появился в каталоге и получил свою панель-досье', h1.includes('Третий бот ТЕСТ') && h1.includes('id="modal-bot-three"') && h1.includes('href="https://t.me/third_test_bot"'));

  // --- архив / восстановление / дубликат на публичной сборке ---
  fs.cpSync(path.join(ROOT, 'src', 'data', 'projects.json'), data('projects'));          // исходные проекты и сцена (без правок выше)
  fs.cpSync(path.join(ROOT, 'src', 'data', 'scene.json'), data('scene'));
  fs.cpSync(path.join(ROOT, 'src', 'data', 'links.json'), data('links'));
  const P = readJ('projects');
  const L = P.landings[1], T = P.trackers[0], B = P.bots[0];
  const names = { L: L.name, T: T.name, B: B.name }, drawers = { L: ops.drawerIdOf('landings', L), T: ops.drawerIdOf('trackers', T), B: B.drawerId };
  ops.archiveProject(P, 'landings', L.id); ops.archiveProject(P, 'trackers', T.id); ops.archiveProject(P, 'bots', B.id);
  writeJ('projects', P);
  const hA = build(path.join(tmp, 'out2'));
  check('архив: лендинг, трекер и бот исчезли с сайта (панели и карточки каталога)', ![drawers.L, drawers.T, drawers.B].some((d) => hA.includes(`id="${d}"`)) && !hA.includes(`data-open-drawer="${drawers.B}"`) && !hA.includes(`data-open-drawer="${drawers.L}"`), [drawers.L, drawers.T, drawers.B].filter((d) => hA.includes(`id="${d}"`)).join(',') + ' | ссылки на панель бота: ' + (hA.match(new RegExp(`data-open-drawer="${drawers.B}"`, 'g')) || []).length);
  check('архив: остальные проекты на месте (4 лендинга, 1 бот)', (hA.match(/id="modal-landing-/g) || []).length === 4 && hA.includes(`id="${P.bots[1].drawerId}"`) && (hA.match(/class="catalog-project-card bot-card/g) || []).length === 1);
  check('архив: сцена, свитки и остальные панели не пострадали', (hA.match(/class="scene-obj /g) || []).length === 15 && hA.includes('hotspot-scroll-bots') && (hA.match(/<aside id="modal-/g) || []).length >= 20, `объектов ${(hA.match(/class="scene-obj /g) || []).length}, панелей ${(hA.match(/<aside id="modal-/g) || []).length}`);
  ops.restoreProject(P, 'landings', L.id); ops.restoreProject(P, 'trackers', T.id); ops.restoreProject(P, 'bots', B.id);
  ops.duplicateProject(P, 'landings', P.landings[0].id);
  writeJ('projects', P);
  const hR = build(path.join(tmp, 'out3'));
  check('восстановление: проекты вернулись на сайт', [drawers.L, drawers.T, drawers.B].every((d) => hR.includes(`id="${d}"`)) && hR.includes(`data-open-drawer="${drawers.B}"`));
  check('дубликат (черновик): панель создана, в каталог «Лендинги» не попала как опубликованная', hR.includes(`id="modal-landing-${P.landings[1].id}"`) && !new RegExp(`class="sites-screen-chip"[^>]*data-open-drawer="modal-landing-${P.landings[1].id}"`).test(hR));
  check('восстановленная сборка: 5+1 панелей лендингов, 2 бота, 15 предметов', (hR.match(/id="modal-landing-/g) || []).length === 6 && (hR.match(/class="catalog-project-card bot-card/g) || []).length === 2 && (hR.match(/class="scene-obj /g) || []).length === 15, `лендингов ${(hR.match(/id="modal-landing-/g) || []).length}, ботов ${(hR.match(/class="catalog-project-card bot-card/g) || []).length}, объектов ${(hR.match(/class="scene-obj /g) || []).length}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\nИтого: PASS ${pass}, FAIL ${fail}`);
process.exit(fail ? 1 : 0);
