import assert from 'node:assert/strict';
import { readAll } from './store.mjs';
import { validateFile } from './validate.mjs';

const data = readAll();
const news = { items: [
  { section: 'lab', title: 'Новость', summary: 'Текст', date: '2026-11-06', published: true, url: 'https://example.com/' },
  { section: 'notes', title: 'Заметка', summary: 'Текст', date: '2026-11-07', published: false, url: '' },
] };
assert.deepEqual(validateFile('news', news).errors, []);
for (const bad of [
  { ...news.items[0], date: '2026-02-30' },
  { ...news.items[0], url: 'javascript:alert(1)' },
  { ...news.items[0], section: 'unknown' },
]) assert.ok(validateFile('news', { items: [bad] }).errors.length);

for (const url of ['https://youtu.be/Dus2-Gl6L1c', 'https://www.youtube.com/watch?v=Dus2-Gl6L1c', 'https://youtube.com/shorts/Dus2-Gl6L1c']) {
  const projects = structuredClone(data.projects);
  projects.videos[0].youtubeUrl = url;
  assert.deepEqual(validateFile('projects', projects).errors, []);
}
for (const url of ['https://youtu.be/12345', 'https://youtube.com/channel/12345678901', 'http://youtu.be/Dus2-Gl6L1c', 'https://youtube.com.evil.test/watch?v=Dus2-Gl6L1c']) {
  const projects = structuredClone(data.projects);
  projects.videos[0].youtubeUrl = url;
  assert.ok(validateFile('projects', projects).errors.some((e) => e.path === 'videos[0].youtubeUrl'), url);
}
console.log('Записи книги и ссылки YouTube: проверки пройдены.');
const scene = structuredClone(data.scene);
const unavailable = scene.items.find((item) => item.id === 'map');
unavailable.visible = true;
assert.ok(validateFile('scene', scene).errors.some((error) => error.path.endsWith('.visible')));
console.log('Недоступный предмет сцены нельзя включить без контура.');
