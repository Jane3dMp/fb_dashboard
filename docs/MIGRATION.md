# Переезд дашборда на app.proznanie.club

Пакет для переезда готов и лежит в папке `api/` — PHP по образцу
`finmodel-club`: без фреймворков, SQLite вместо Google Sheets, cron вместо
триггеров, секреты только в `config.php` на сервере. Страницы дашборда не
меняются вовсе: `people.html` не отличает новый бэкенд от Apps Script —
ответ совместим поле в поле.

## Что в пакете

| Файл | Что делает | Заменяет в Apps Script |
|---|---|---|
| `api/etl.php` | cron-выгрузки amo/Альфы в SQLite | runAmoEtl, pplEtlAlfaCustomers, pplRebuildPays, триггеры |
| `api/people.php` | endpoint «Путь клиента» | doGet → buildPeople (view=people) |
| `api/webhook.php` | приёмник вебхука Instagram, с проверкой подписи Meta | проект «IG webhook» целиком |
| `api/core.php` | расчётное ядро (мост, деньги, разрезы) | pplAlfaRevenueCore_, pplChannelSummary_ |
| `api/lib.php`, `api/db.php` | конфиг, HTTP-клиенты, SQLite | Свойства скрипта, CacheService, Sheets |
| `api/config.example.php` | шаблон секретов | Свойства скрипта |
| `api/tests/core.test.php` | паритетные тесты ядра (те же сценарии, что `tests/logic.test.js`) | — |
| `.github/workflows/deploy-hosting.yml` | php-lint + тесты + FTPS-деплой | — |

Что переезжает первым этапом: страница «Путь клиента» (view=people) — она
самая ценная и самая тяжёлая для Apps Script. Остальные view (funnel,
channel, brands, kanikuly) остаются в Apps Script и переносятся по одному
тем же способом (см. «Этап 2» внизу).

## Чек-лист переезда (по порядку)

**1. FTP-аккаунт под дашборд.** В панели хостинга создать FTP-аккаунт,
«запертый» в отдельной папке, например `analytics/` внутри корня
app.proznanie.club (так же, как для finmodel сделан аккаунт в `finmodel/`).
Запомнить хост/логин/пароль.

**2. Секреты в GitHub.** В репозитории `fb_dashboard`: Settings → Secrets
and variables → Actions:
- секреты `FTP_HOST`, `FTP_USER`, `FTP_PASSWORD` — из шага 1;
- переменную (вкладка Variables) `DEPLOY_HOSTING` = `on` — она включает
  job деплоя (без неё воркфлоу гоняет только проверки PHP).

После этого любой push в main заливает страницы и `api/` на хостинг.
Первый деплой можно запустить руками: Actions → Deploy dashboard to
hosting → Run workflow.

**3. `config.php` на сервере.** В файловом менеджере хостинга скопировать
`analytics/api/config.example.php` → `analytics/api/config.php` и заполнить.
Все значения уже есть в «Свойствах скрипта» проекта Apps Script «ФБ»
(Настройки проекта): amo-токен, ключ Альфы, токен Meta, DASH_KEY, FX_RATE.
`cron_key` и `webhook_secret` — придумать новые случайные строки.
В git этот файл не попадает, автозаливка его не трогает (exclude),
через веб не читается (.htaccess).

**4. Первый прогон ETL.** В браузере (или curl):
`https://app.proznanie.club/analytics/api/etl.php?job=nightly&cron_key=<ваш>`
Ждать до пары минут; ответ — JSON с числом строк (ориентиры: leads ~5300,
customers ~1700, pays ~29000). База появится в `analytics/api/data/`.

**5. Cron хостинга.** Два задания (cPanel → Cron Jobs):
- каждые 15 минут: `php /home/<акк>/app.proznanie.club/analytics/api/etl.php job=delta`
- раз в сутки, ночью (например 4:30): `... job=nightly`
Если cron умеет только URL — те же вызовы через curl с `&cron_key=`.

**6. Проверка и переключение страницы.** Открыть руками:
`https://app.proznanie.club/analytics/api/people.php?days=30&key=<DASH_KEY>`
— должен прийти тот же JSON, что от Apps Script (сравнить revenue.revenue
на одинаковом окне). Затем в `assets/dash.js` раскомментировать строку
`people:` в `HOSTED_VIEWS`, закоммитить, запушить. С этого момента «Путь
клиента» ходит на хостинг, остальные страницы — в Apps Script.
**Откат** — закомментировать строку обратно: Apps Script никуда не девался.

**7. (после App Review) Вебхук.** В Meta сменить Callback URL на
`https://app.proznanie.club/analytics/api/webhook.php?s=<webhook_secret>`
(Verify Token тот же). Вписать `app_secret` приложения в config.php —
включится проверка настоящей подписи Meta, которой в Apps Script не было
в принципе. Проект «IG webhook» после этого можно выключить.

**8. Отключение Apps Script (не раньше чем через неделю-две спокойной
работы).** Снять триггеры (`pplSetupDailyTriggers` больше не запускать,
существующие удалить в разделе «Триггеры»), проект не удалять — он
остаётся откатом и источником остальных view до этапа 2.

## Что намеренно сделано иначе, чем в Apps Script

- **SQLite вместо Google Sheets** — нет лимита 6 минут, нет капризного
  редактора, бэкап = скачать один файл `data/dashboard.sqlite`.
- **Cron-дельта раз в 15 минут вместо «живой дельты в запросе»** — ответ
  собирается за секунды из почти-живой базы; кнопка «Обновить сейчас» на
  странице продолжает работать (nocache обходит 10-минутный кэш файлов).
- **Вебхук проверяет подпись Meta** (X-Hub-Signature-256) — в Apps Script
  заголовки недоступны, там был только секрет в URL.
- **`people` в ответе пока пустой** — как и сейчас: реальные клики Meta
  начнёт слать после App Review, webhook.php уже готов их писать.

## Этап 2 (после спокойной недели на этапе 1)

Перенести остальные view тем же паттерном: их данные (MART_*) — это
агрегаты от тех же leads/pays, SQL-запросы поверх готовой SQLite-базы.
На каждый view — свой маленький endpoint (funnel.php, brands.php,
kanikuly.php) и строка в `HOSTED_VIEWS`. Отдельная задача — kanikuly
(сверка со сменами ходит в Альфу за группами; портировать
buildKanikulySverka в etl.php).
