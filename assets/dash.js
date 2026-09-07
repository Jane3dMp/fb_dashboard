/**
 * Общее для всех страниц дашборда: адрес бэкенда, замок и запросы к API.
 *
 * Пароль намеренно НЕ хранится в этом файле. Раньше он лежал константой
 * в каждой странице, то есть в публичном репозитории, и проверялся на
 * клиенте — открыв исходник страницы или дёрнув Apps Script напрямую,
 * данные мог получить кто угодно. Теперь введённый пароль просто уходит
 * на бэкенд параметром key, а решение пускать или нет принимает Apps
 * Script. Пока в бэкенд не добавлена проверка, лишний параметр он
 * игнорирует и всё продолжает работать как раньше.
 */
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwUcboOjB-_cLVnh549OU6BLK43F4rBn6QDN6eVohKfc5YAcNP2T-K_KVRqKm4_iHg4/exec';

/**
 * Поэтапный переезд на app.proznanie.club: view, вписанный сюда, ходит на
 * хостинг, остальные — по-прежнему в Apps Script. Чтобы переключить
 * «Путь клиента», раскомментируйте строку (см. docs/MIGRATION.md, шаг 6):
 */
const HOSTED_VIEWS = {
  // people: 'https://app.proznanie.club/analytics/api/people.php',
};

const KEY_STORAGE = 'fb_dash_key';

/* ---------- замок ---------- */

/**
 * Хранилище доступно не всегда: в приватном окне и при запрете данных
 * сайта сам доступ к sessionStorage бросает исключение. Раньше оно
 * летело из первой же строки файла и обрывало выполнение — страница
 * оставалась без замка и без всего, что объявлено ниже.
 */
function dashKey() {
  try { return sessionStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
}

function showGate(message) {
  const gate = document.getElementById('gate');
  if (!gate) return;
  gate.style.display = 'flex';
  const input = document.getElementById('passInput');
  if (input) {
    input.value = '';
    if (message) input.placeholder = message;
    input.focus();
  }
}

/**
 * Пароль больше не сверяется здесь — правильность знает только бэкенд.
 * Поэтому замок открывается сразу, а если ключ окажется неверным,
 * первый же запрос вернёт 401 и замок появится снова.
 */
function checkPass(e) {
  e.preventDefault();
  const input = document.getElementById('passInput');
  if (!input.value) return false;
  try { sessionStorage.setItem(KEY_STORAGE, input.value); } catch (e) {}
  document.getElementById('gate').style.display = 'none';
  if (typeof loadData === 'function') loadData();
  return false;
}

if (dashKey()) {
  document.addEventListener('DOMContentLoaded', function () {
    const gate = document.getElementById('gate');
    if (gate) gate.style.display = 'none';
  });
}

/* ---------- запросы ---------- */

/**
 * Запрос к бэкенду. query — строка вида 'view=people&days=30'.
 * Бросает исключение с текстом ошибки; на неверный пароль показывает замок.
 */
async function api(query) {
  const view = (query.match(/view=(\w+)/) || [])[1];
  const base = HOSTED_VIEWS[view] || GAS_URL;
  const resp = await fetch(base + '?' + query + '&key=' + encodeURIComponent(dashKey()));
  if (resp.status === 401 || resp.status === 403) {
    try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) {}
    showGate('Неверный пароль');
    throw new Error('Нужен пароль');
  }
  const data = await resp.json();
  // Apps Script в норме отвечает 200 на всё, поэтому отказ доступа
  // может прийти и полем в теле ответа
  if (data.error === 'unauthorized') {
    try { sessionStorage.removeItem(KEY_STORAGE); } catch (e) {}
    showGate('Неверный пароль');
    throw new Error('Нужен пароль');
  }
  if (data.error) throw new Error(data.error);
  return data;
}

/* ---------- превью креативов ---------- */

/**
 * Миниатюра объявления и просмотр её крупно по клику.
 *
 * Живёт здесь, а не в двух копиях: картинки нужны и «Дням», и «Сейчас
 * активно», а разметка с поведением и стилем должны меняться вместе —
 * помощник, который молча зависит от CSS в чужом файле, ломается тихо.
 */

/** Экранирование значения атрибута: ссылку даёт Meta, доверять ей нельзя. */
function attr(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** <img> миниатюры креатива; серый прямоугольник, если картинки нет. */
function thumbImg(url) {
  if (!url) return '<span class="thumb"></span>';
  return '<img class="thumb" loading="lazy" referrerpolicy="no-referrer" alt="" ' +
    'src="' + attr(url) + '" ' +
    // ссылки Meta подписанные и однажды протухают — тогда вместо битой
    // картинки остаётся тот же серый прямоугольник
    'onerror="this.removeAttribute(\'src\');this.removeAttribute(\'onerror\')">';
}

/** Первая ячейка строки объявления: миниатюра, название и подпись под ним. */
function adCell(url, title, sub) {
  return '<div class="adcell">' + thumbImg(url) +
    '<div>' + title + (sub ? '<small>' + sub + '</small>' : '') + '</div></div>';
}

/**
 * Один слушатель на документ, а не на каждой картинке: таблицы
 * перерисовываются при каждом переключении режима, и слушателей пришлось
 * бы вешать заново.
 */
function initThumbLightbox() {
  const css = document.createElement('style');
  css.textContent =
    '.adcell{display:flex;gap:10px;align-items:flex-start}' +
    '.adcell>div{min-width:0}' +
    '.thumb{width:44px;height:44px;flex:0 0 44px;border-radius:8px;' +
      'object-fit:cover;background:var(--line,#EBE6DB);display:block}' +
    'img.thumb{cursor:zoom-in}' +
    '.lightbox{position:fixed;inset:0;background:rgba(28,27,25,.72);z-index:60;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;cursor:zoom-out}' +
    '.lightbox img{max-width:min(90vw,520px);max-height:86vh;border-radius:12px;' +
      'box-shadow:0 8px 40px rgba(0,0,0,.35)}' +
    '@media print{.lightbox{display:none !important}}';
  document.head.appendChild(css);

  const box = document.createElement('div');
  box.className = 'lightbox';
  box.style.display = 'none';
  const big = document.createElement('img');
  big.alt = '';
  big.referrerPolicy = 'no-referrer';
  box.appendChild(big);
  document.body.appendChild(box);

  document.addEventListener('click', function (e) {
    const t = e.target.closest && e.target.closest('img.thumb');
    if (t && t.src) { big.src = t.src; box.style.display = 'flex'; return; }
    box.style.display = 'none';
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') box.style.display = 'none';
  });
}

// Файл подключён в конце <body> на всех страницах, поэтому ни head, ни
// body ждать не надо. Через DOMContentLoaded было хуже: стоило чему-то
// выше бросить исключение — и стили миниатюр не появлялись вовсе.
initThumbLightbox();
