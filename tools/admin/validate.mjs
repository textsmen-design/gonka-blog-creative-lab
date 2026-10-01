// tools/admin/validate.mjs — интерпретатор подмножества JSON Schema draft-07
// + бизнес-правила (allowlist ссылок, файлы медиа, предупреждения).
// Внешних зависимостей нет. Наружу отдаются только пути и сообщения — без данных.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './store.mjs';

const LINK_RE =
  /^(https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[^\s]*)?|mailto:[^\s@]+@[^\s@]+\.[A-Za-z]{2,}|#[A-Za-z0-9_-]+|\/[^\s]*)$/;
const MEDIA_PATH_RE = /^\/previews\/[a-z0-9.-]+\.(jpg|png|webp|svg)$/;
const DANGEROUS_RE = /^\s*(javascript|data|vbscript|file):/i;

const schemaCache = new Map();

export function loadSchema(name) {
  if (schemaCache.has(name)) return schemaCache.get(name);
  const p = path.join(paths().schemaDir, `${name}.schema.json`);
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  schemaCache.set(name, doc);
  return doc;
}

function resolveRef(ref, doc) {
  if (!ref.startsWith('#/')) throw new Error('unsupported $ref: ' + ref);
  let node = doc;
  for (const seg of ref.slice(2).split('/')) {
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (!node) throw new Error('unresolved $ref: ' + ref);
  return node;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string | boolean | object
}

function typeMatches(expected, actual) {
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return expected === actual;
}

function pushErr(errs, at, msg) {
  errs.push({ path: at || '(root)', message: msg });
}

function validateNode(schema, data, at, errs, doc, depth) {
  if (depth > 100) { pushErr(errs, at, 'слишком глубокая вложенность'); return; }
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    validateNode(resolveRef(schema.$ref, doc), data, at, errs, doc, depth + 1);
    return;
  }
  if (schema.oneOf) {
    const results = schema.oneOf.map((s) => {
      const e = [];
      validateNode(s, data, at, e, doc, depth + 1);
      return e;
    });
    const ok = results.filter((e) => e.length === 0).length;
    if (ok !== 1) {
      pushErr(errs, at, `не соответствует ни одной из ${schema.oneOf.length} разрешённых форм` +
        (ok > 1 ? ' (несколько совпадений)' : ''));
      // добавляем ошибки первого варианта как подсказку
      for (const e of results[0].slice(0, 3)) pushErr(errs, e.path, e.message);
    }
    return;
  }
  if (schema.allOf) {
    for (const s of schema.allOf) validateNode(s, data, at, errs, doc, depth + 1);
    return;
  }
  if ('const' in schema) {
    if (JSON.stringify(data) !== JSON.stringify(schema.const)) {
      pushErr(errs, at, 'значение должно быть фиксированным');
    }
    return;
  }
  if (schema.enum) {
    if (!schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(data))) {
      pushErr(errs, at, 'значение вне допустимого списка');
    }
    return;
  }

  const actual = typeOf(data);
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((t) => typeMatches(t, actual))) {
      pushErr(errs, at, `ожидается ${expected.join('|')}, получено ${actual}`);
      return;
    }
  }

  if (actual === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      pushErr(errs, at, `строка короче ${schema.minLength} симв.`);
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      pushErr(errs, at, `строка длиннее ${schema.maxLength} симв.`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) {
      pushErr(errs, at, `не соответствует требуемому формату`);
    }
    return;
  }

  if (actual === 'array') {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      pushErr(errs, at, `элементов меньше, чем требуется: ${data.length} < ${schema.minItems} (структура заморожена)`);
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      pushErr(errs, at, `элементов больше, чем разрешено: ${data.length} > ${schema.maxItems} (структура заморожена)`);
    }
    if (Array.isArray(schema.items)) {
      data.forEach((v, i) => {
        if (i < schema.items.length) validateNode(schema.items[i], v, `${at}[${i}]`, errs, doc, depth + 1);
        else pushErr(errs, `${at}[${i}]`, 'лишний элемент (позиция заморожена)');
      });
    } else if (schema.items) {
      data.forEach((v, i) => validateNode(schema.items, v, `${at}[${i}]`, errs, doc, depth + 1));
    }
    return;
  }

  if (actual === 'object') {
    for (const key of schema.required || []) {
      if (!(key in data)) pushErr(errs, at, `обязательный ключ отсутствует: ${key}`);
    }
    const props = schema.properties || {};
    for (const [key, val] of Object.entries(data)) {
      if (key in props) {
        validateNode(props[key], val, at ? `${at}.${key}` : key, errs, doc, depth + 1);
      } else if (schema.additionalProperties === false) {
        pushErr(errs, at ? `${at}.${key}` : key, 'неизвестный ключ (запрещено схемой)');
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateNode(schema.additionalProperties, val, at ? `${at}.${key}` : key, errs, doc, depth + 1);
      }
    }
  }
}

export function validateAgainstSchema(name, data) {
  const doc = loadSchema(name);
  const errs = [];
  validateNode(doc, data, '', errs, doc, 0);
  return errs;
}

// --- Бизнес-правила: allowlist ссылок, медиа-файлы, предупреждения ---

export function businessRules(name, data) {
  const errors = [];
  const warnings = [];
  const p = paths();

  const warnLong = (at, s, limit) => {
    if (typeof s === 'string' && s.length > limit) {
      warnings.push({ path: at, message: `длинная строка: ${s.length} симв. (рекомендуется ≤ ${limit})` });
    }
  };
  const warnTrim = (at, s) => {
    if (typeof s === 'string' && s !== s.trim() && s.trim().length > 0) {
      warnings.push({ path: at, message: 'лишние пробелы в начале/конце' });
    }
  };
  const walk = (node, at, cb) => {
    cb(node, at);
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${at}[${i}]`, cb));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, at ? `${at}.${k}` : k, cb);
    }
  };

  if (name === 'links') {
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string') continue; // тип покрыт схемой
      if (DANGEROUS_RE.test(value)) {
        errors.push({ path: key, message: 'запрещённая схема ссылки (javascript/data/vbscript/file)' });
      } else if (!LINK_RE.test(value)) {
        errors.push({ path: key, message: 'ссылка вне allowlist (https:// | mailto: | #якорь | /путь)' });
      }
      warnTrim(key, value);
    }
  }

  if (name === 'media' && data && typeof data.previews === 'object' && data.previews) {
    for (const [key, value] of Object.entries(data.previews)) {
      if (typeof value !== 'string') continue;
      if (!MEDIA_PATH_RE.test(value)) {
        errors.push({ path: `previews.${key}`, message: 'путь вне allowlist /previews/<имя>.jpg|png|webp|svg' });
        continue;
      }
      const abs = path.join(p.publicDir, value);
      if (!fs.existsSync(abs)) {
        errors.push({ path: `previews.${key}`, message: 'файл не найден в public/' });
      } else {
        const size = fs.statSync(abs).size;
        if (size > 2 * 1024 * 1024) {
          errors.push({ path: `previews.${key}`, message: `файл больше 2 МБ (${size} байт)` });
        }
      }
    }
  }

  if (name === 'site' && data && data.meta) {
    warnLong('meta.title', data.meta.title, 70);
    warnLong('meta.description', data.meta.description, 160);
  }

  // общие предупреждения по всем файлам
  walk(data, '', (node, at) => {
    if (typeof node === 'string') {
      warnTrim(at, node);
      warnLong(at, node, 500);
    }
  });

  return { errors, warnings };
}

export function validateFile(name, data) {
  const schemaErrors = validateAgainstSchema(name, data);
  const rules = businessRules(name, data);
  return {
    errors: [...schemaErrors, ...rules.errors],
    warnings: rules.warnings,
  };
}
