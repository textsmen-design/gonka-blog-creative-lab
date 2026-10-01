# Админка GONKA.BLOG (Этап 2)

Локальная админка для редактирования контента `src/data/*.json`. Только `127.0.0.1`, в `dist` не попадает, сайт не меняет.

## Запуск

```bash
npm run admin          # http://127.0.0.1:4310
cat tools/admin/.token # токен (создаётся при первом запуске, права 0600)
```

В браузере: открыть `http://127.0.0.1:4310`, ввести токен (хранится в `sessionStorage` вкладки).

После правок — сборка **вручную** (кнопки сборки в админке нет):

```bash
npm run build
```

## Команды

| Команда | Что делает |
|---|---|
| `npm run admin` | запуск сервера админки |
| `npm run check:bindings` | привязки JSON ↔ `SpatialWorkbench.astro` / `index.astro` |
| `npm run verify:dist` | в `dist` нет админки и запрещённых маркеров |
| `npm run verify:dist -- --manifest путь.sha256` | сверка `dist` с манифестом |

## Как сохраняется

1. `POST /api/save` → схема + привязки → **бэкап** → атомарная запись (tmp + fsync + rename) → `audit.log`.
2. Параллельные записи разрушаются lock-файлом (`.admin.lock`), устаревшие (>30 c) снимаются по PID.
3. Изменённый не вами файл → `409`, нажмите «Перезагрузить».
4. Откат: вкладка «История» → «Восстановить» (после бэкапа валидируется и он).

Перед сохранением показывается панель diff — подтвердите, что видите.

## Правила контента

- **Длины и порядок массивов заморожены** — add/remove/reorder не пройдут схему.
- Хардкод-узлы вёрстки не редактируются (8 узлов в компоненте; например, `desc` карточки Tracker_01 №6).
- Ссылки — только allowlist (`https:`, `http:`, `mailto:`, `#…`); `javascript:` и пр. запрещены.
- `media` — путь `/previews/…` + существование файла ≤ 2 МБ.
- `set:html` не используется нигде — контент экранируется Astro (проверено на XSS-строке).

## API

| Метод | Путь | Тело | Ответы |
|---|---|---|---|
| GET | `/api/data` | — | `{data, etags, files}` |
| GET | `/api/backups` | — | `{backups}` |
| POST | `/api/save` | `{file, data, ifMatch}` | 200 / 409 etag / 409 lock / 422 / 413 / 415 / 401 / 429 |
| POST | `/api/restore` | `{name, ifMatch}` | 200 / 409 / 422 / 404 |

Авторизация: `Authorization: Bearer <токен>`; 5 неверных попыток → блок 60 с; Host/Origin только localhost.

## Переменные окружения

`ADMIN_PORT` (4310), `ADMIN_TOKEN`, `ADMIN_TOKEN_FILE`, `ADMIN_DATA_DIR`, `ADMIN_AUDIT_FILE`, `ADMIN_PUBLIC_DIR`.

## Файлы (gitignore)

`tools/admin/.token`, `tools/admin/audit.log`, `src/data/.backups/`, `src/data/.admin.lock`, `src/data/.tmp/`.

## Ограничения

- Порядок массивов одинаковых элементов (`cards`, `nav`, строки списков) ловится не всегда — смотрите diff перед подтверждением.
- Кнопки сборки и авто-git-коммитов нет.
- `DEPLOY.md` не менялся: `verify:dist` к деплою ещё не подключён.
