# Дашборды «Прознание / CODDY»

Статические страницы на GitHub Pages. Данные отдаёт Google Apps Script,
который ходит в Meta Ads API, amoCRM и Альфа-CRM.

| Страница | Что показывает |
|---|---|
| `index.html` | Расход Meta Ads по кабинетам и кампаниям |
| `funnel.html` | Этапы сделок amoCRM, конверсия |
| `channel.html` | Instagram: расход против заявок, помесячно |
| `brands.html` | Заявки по направлениям |
| `kanikuly.html` | Сверка записей на смены с сделками amoCRM |
| `people.html` | **Сквозная аналитика**: клик по объявлению → человек → сделка → деньги |

`assets/dash.js` — общий для всех страниц: адрес бэкенда, замок, функция `api()`.

## Сквозная аналитика: как это работает

Обычная связка ломается в одном месте: когда человек приходит из рекламы
click-to-Instagram-Direct, идентификатор объявления есть только в первом
сообщении, а штатная интеграция amoCRM его не сохраняет. Поэтому клик
перехватывается отдельно.

```
Meta Ads ──клик──> Instagram Direct
                        │
        ┌───────────────┴───────────────┐
   webhook.gs                    интеграция amoCRM
   ловит referral.ad_id          создаёт сделку
        │                               │
        ▼                               ▼
   лист «Клики»                    amoCRM API
   igsid, ad_id, ts                сделка, статус, сумма
        └──────────► people.gs ◄────────┘
                  склейка по IGSID
                        ▼
                  people.html
```

### Порядок внедрения

**1. Приёмник кликов** (`apps-script/webhook.gs`)

Отдельный проект Apps Script, не тот, что отдаёт данные дашбордам.

- Свойства скрипта: `VERIFY_TOKEN`, `URL_SECRET`, `SHEET_ID`
- Задеплоить как веб-приложение, доступ «Все»
- В Meta для приложения → Webhooks → Instagram → поле `messages`
  - Callback URL: `https://script.google.com/macros/s/<ID>/exec?s=<URL_SECRET>`
  - Verify Token: значение `VERIFY_TOKEN`
- Нужно разрешение `instagram_manage_messages` с advanced access

**2. Склейка** (`apps-script/people.gs`)

Добавляется в существующий проект Apps Script. В его `doGet` дописать:

```js
if (e.parameter.view === 'people') return json_(buildPeople(e.parameter));
```

Свойства скрипта: `CLICKS_SHEET_ID`, `AMO_SUBDOMAIN`, `AMO_TOKEN`,
`META_TOKEN`, `META_ACCOUNTS`, опционально `AMO_IGSID_FIELD`.

**3. Точность связки**

Без `AMO_IGSID_FIELD` сделки сопоставляются с кликами по времени — это
приблизительно, и страница честно пишет, сколько связей угадано. Чтобы
считать точно, нужно завести в контакте amoCRM поле под IGSID, заполнять
его при создании сделки из директа и указать id поля в свойствах скрипта.

**4. Чего эта схема не покроет**

Заявки по телефону, WhatsApp и сарафану в сквозную аналитику не попадут
никогда — у них нет клика. Для них остаётся поле «источник» и дисциплина
заполнения.

## Доступ и персональные данные

Пароль больше не хранится в коде страниц: он вводится пользователем и
уходит на бэкенд параметром `key`, а пускать или нет решает Apps Script.

**Проверку на стороне бэкенда нужно включить.** Пока её нет, любой, кто
знает адрес `/exec`, получает данные без пароля. В начало `doGet`:

```js
function doGet(e) {
  if (e.parameter.key !== PropertiesService.getScriptProperties().getProperty('DASH_KEY')) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // ... остальной doGet
}
```

Это особенно важно для `people.html`: в отличие от остальных страниц, она
показывает пофамильный список детей и родителей. До включения проверки
выкладывать её в публичный доступ не стоит.

## Локальный запуск

```
python -m http.server 8123
```

и открыть `http://localhost:8123/index.html`.

## Тесты

```
node tests/logic.test.js
```

Прогоняют логику склейки из `people.gs` в Node с заглушками вместо объектов
Google — в самом Apps Script её негде выполнить. Покрыты оба пути
сопоставления, переходный режим и краевые случаи сводки по объявлениям.
