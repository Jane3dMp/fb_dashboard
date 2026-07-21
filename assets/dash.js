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

const KEY_STORAGE = 'fb_dash_key';

/* ---------- замок ---------- */

function dashKey() {
  return sessionStorage.getItem(KEY_STORAGE) || '';
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
  sessionStorage.setItem(KEY_STORAGE, input.value);
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
  const resp = await fetch(GAS_URL + '?' + query + '&key=' + encodeURIComponent(dashKey()));
  if (resp.status === 401 || resp.status === 403) {
    sessionStorage.removeItem(KEY_STORAGE);
    showGate('Неверный пароль');
    throw new Error('Нужен пароль');
  }
  const data = await resp.json();
  // Apps Script в норме отвечает 200 на всё, поэтому отказ доступа
  // может прийти и полем в теле ответа
  if (data.error === 'unauthorized') {
    sessionStorage.removeItem(KEY_STORAGE);
    showGate('Неверный пароль');
    throw new Error('Нужен пароль');
  }
  if (data.error) throw new Error(data.error);
  return data;
}
