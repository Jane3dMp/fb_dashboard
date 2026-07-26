# Стиль дашбордов «Прознание / CODDY»

Переносимая дизайн-система: тёплая «бумажная» подложка, белые карточки,
всё круглое, акценты жёлтым, активное состояние — чёрная пилюля.
Скопируйте блок токенов — и вы уже в этом стиле.

## Шрифты

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

- **Poppins 600** — только логотип и заголовки страниц (`letter-spacing:-.02em`)
- **Inter** — весь остальной текст
- Числам всегда `font-variant-numeric: tabular-nums` — колонки цифр не «пляшут»

## Токены

```css
:root{
  --cream:#F5F1E8;        /* фон страницы */
  --card:#FFFFFF;         /* карточки */
  --ink:#1C1B19;          /* основной текст, активные элементы */
  --ink2:#6E6A62;         /* вторичный текст, подписи */
  --yellow:#FFD93B;       /* фирменный акцент: главные KPI, кнопка действия */
  --yellow-soft:#FBF0C4;  /* информационные плашки */
  --line:#EBE6DB;         /* линии таблиц, рамки */
  --blue:#3B5BDB;         /* ссылки */
  --green:#2E7D46;        /* «деньги, хорошо» */
  --red:#C0392B;          /* предупреждения */
  --shadow:0 2px 14px rgba(28,27,25,.06);  /* еле заметная тень карточек */
}
body{
  font-family:'Inter',sans-serif;
  background:var(--cream);
  color:var(--ink);
  -webkit-font-smoothing:antialiased;
}
```

## Правила формы

- **Всё круглое.** Кнопки, навигация, поля ввода — пилюли
  `border-radius:100px`. Карточки — `border-radius:16–20px`.
- **Активное состояние — инверсия**: чёрная пилюля, белый текст.
  Не цветом, не подчёркиванием — инверсией.
- **Одна колонка контента** `max-width:1160px; margin:0 auto`,
  боковые поля 24px.
- Тени почти невидимые (`--shadow`), никаких границ у карточек.
- Тёмной темы нет — стиль принципиально «бумажный», светлый.

## Компоненты

Навигация (пилюля в пилюле):

```css
nav{display:flex;gap:2px;background:var(--card);padding:6px;border-radius:100px;box-shadow:var(--shadow)}
nav a{color:var(--ink2);font-size:13px;font-weight:500;text-decoration:none;padding:9px 18px;border-radius:100px;transition:.15s}
nav a:hover{color:var(--ink)}
nav a.active{background:var(--ink);color:#fff}
```

Кнопка-фильтр:

```css
button{font:500 13px 'Inter',sans-serif;background:var(--card);
  border:1px solid var(--line);border-radius:100px;padding:8px 16px;
  cursor:pointer;color:var(--ink)}
button.active{background:var(--ink);color:#fff;border-color:var(--ink)}
```

KPI-карточка (крупная цифра, подпись сверху, расшифровка снизу):

```css
.kpi{background:var(--card);border-radius:18px;padding:18px 20px;box-shadow:var(--shadow)}
.kpi .label{font-size:12px;color:var(--ink2)}
.kpi .value{font-family:'Poppins',sans-serif;font-weight:600;font-size:30px}
.kpi .sub{font-size:12px;color:var(--ink2)}
.kpi.accent{background:var(--yellow-soft)}   /* главные показатели */
.kpi .value.money{color:var(--green)}        /* деньги — зелёным */
```

Таблица:

```css
th{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--ink2);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
td{font-size:14px;padding:11px 12px;border-bottom:1px solid var(--line)}
td.zero{color:#c9c4b8}   /* нули и пустоты приглушаются, а не прячутся */
```

Плашка-примечание (методология — жёлтая, предупреждение — розовая):

```css
.note{background:var(--yellow-soft);border-radius:14px;padding:14px 18px;
  font-size:13.5px;line-height:1.55;color:var(--ink)}
.note.warn{background:#F9E3DD}
```

## Тон

- Каждая цифра, которой нельзя верить безоговорочно, сопровождается
  честной сноской человеческим языком: «это нижняя граница, а не точная
  цифра», «на коротком окне всегда занижено — сравнивайте 90 дней».
- Дизайн спокойный, внимание держат цифры, а не оформление.
- Пустое значение — приглушённый прочерк, не ноль и не скрытая строка.
