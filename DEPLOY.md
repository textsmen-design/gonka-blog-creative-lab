# DEPLOY — GONKA.BLOG (Личная цифровая лаборатория)

| Параметр | Значение |
| :--- | :--- |
| **Проект** | GONKA.BLOG — Личная цифровая лаборатория |
| **Тип проекта** | Статический сайт (`static` / Astro static build) |
| **Целевой сервер** | VDS #1 (Москва, `62.109.5.155`) |
| **URL / Домен** | `https://gonka.blog` (и алиас `https://www.gonka.blog`) |
| **DNS** | Netlify DNS (wildcard `*.gonka.blog → 62.109.5.155`), без изменений |
| **Путь размещения** | `/var/www/gonka-blog-landing/frontend` |
| **Сетевой стек** | Nginx (`/etc/nginx/sites-available/gonka-blog-root`) |
| **SSL-сертификат** | Let's Encrypt Certbot (`/etc/letsencrypt/live/gonka.blog/fullchain.pem`) |
| **Systemd-служба** | Не требуется (статический сайт обслуживается напрямую Nginx) |
| **GitHub репозиторий** | `textsmen-design/gonka-blog-creative-lab` |

---

## 🛠 Архитектура и изоляция

1. **Переиспользование существующей установки (п.6 CORE)**:
   - На VDS #1 уже присутствует настроенная конфигурация `gonka-blog-root` с валидным SSL-сертификатом от Let's Encrypt и автоматическим 301-редиректом с HTTP на HTTPS.
   - Второй конфликтующий nginx server block **не создаётся**.
   - Дополнительный systemd-сервис **не создаётся**.
   - Деплой аккуратно обновляет рабочие статические файлы в существующем `document_root` (`/var/www/gonka-blog-landing/frontend`).

2. **Сборка и доставка**:
   - Сборка выполняется локально через `npm run build` в директорию `./dist/`.
   - Готовые статические артефакты синхронизируются через `rsync` на VDS #1.
   - Nginx перезагружается через `systemctl reload nginx` после предварительной проверки конфигурации `nginx -t`.

3. **Команды для деплоя**:
   ```bash
   # Сборка проекта
   npm run build

   # Доставка файлов на VDS #1
   rsync -av --delete dist/ root@62.109.5.155:/var/www/gonka-blog-landing/frontend/

   # Проверка и перезагрузка Nginx
   ssh root@62.109.5.155 "nginx -t && systemctl reload nginx"
   ```
