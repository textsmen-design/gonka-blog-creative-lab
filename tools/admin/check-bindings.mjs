#!/usr/bin/env node
// tools/admin/check-bindings.mjs — сверка «шаблон ↔ JSON» из консоли.
// Использование: node tools/admin/check-bindings.mjs [--data-dir <dir>]
// Коды выхода: 0 — ок; 1 — есть ошибки; 2 — исходные данные невалидны.
import { checkBindings } from './bindings.mjs';
import { FILE_NAMES, readAll } from './store.mjs';

const args = process.argv.slice(2);
const di = args.indexOf('--data-dir');
if (di !== -1 && args[di + 1]) process.env.ADMIN_DATA_DIR = args[di + 1];

let data;
try {
  data = readAll();
} catch (e) {
  console.error('FAIL: данные не читаются —', e.message);
  process.exit(2);
}

const res = checkBindings({ data });

for (const e of res.errors) console.log(`ERROR   ${e.path}: ${e.message}`);
for (const w of res.warnings) console.log(`WARN    ${w.path}: ${w.message}`);
console.log(
  `Итого: ошибок ${res.errors.length}, предупреждений ${res.warnings.length}` +
    ` (выражений: ${res.stats.expr}, разрешено: ${res.stats.resolved}, пропущено: ${res.stats.skipped})`
);
process.exit(res.errors.length ? 1 : 0);
