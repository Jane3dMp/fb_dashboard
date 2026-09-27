/**
 * Приёмник вебхуков Instagram Messaging.
 *
 * Задача: поймать МОМЕНТ КЛИКА. Когда человек приходит из рекламы
 * click-to-Instagram-Direct, Meta кладёт в первое сообщение объект referral
 * с ad_id — это единственное место во всей цепочке, где известно,
 * какое объявление привело этого конкретного человека. В amoCRM этот
 * идентификатор уже не попадает, поэтому ловим его здесь и складываем в лист.
 *
 * ВАЖНО: это ОТДЕЛЬНЫЙ проект Apps Script со своим деплоем.
 * Не смешивать с проектом, который отдаёт данные дашбордам:
 * там doGet занят выдачей JSON, а здесь он нужен Meta для верификации.
 *
 * --- Настройка (Свойства скрипта) ---
 *   VERIFY_TOKEN — произвольная строка, её же вписать в Meta при подписке
 *   URL_SECRET   — произвольная строка, добавляется к callback URL как ?s=...
 *   SHEET_ID     — id таблицы, куда писать
 *
 * --- Подписка в Meta ---
 *   Callback URL: https://script.google.com/macros/s/<ID>/exec?s=<URL_SECRET>
 *   Verify Token: <VERIFY_TOKEN>
 *   Поле подписки: messages (продукт Instagram)
 *
 * --- О защите ---
 * Apps Script не даёт доступа к заголовкам HTTP-запроса, поэтому проверить
 * подпись Meta (X-Hub-Signature-256) здесь невозможно в принципе. Вместо неё
 * используется секрет в query-строке: Meta сохраняет параметры callback URL
 * и присылает их обратно. Это слабее подписи — секрет виден в логах Google,
 * но не даёт постороннему просто так писать в таблицу, зная только URL.
 * Если понадобится настоящая проверка подписи — приёмник придётся вынести
 * на Cloudflare Worker или любой другой рантайм с доступом к заголовкам.
 */

const SHEET_NAME = 'Клики';
const HEADERS = ['ts', 'igsid', 'ad_id', 'ref', 'ad_title', 'media_url', 'first_text', 'raw'];

/** Верификация подписки: Meta дёргает GET с hub.challenge. */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p['hub.mode'] === 'subscribe' && p['hub.verify_token'] === prop_('VERIFY_TOKEN')) {
    return ContentService.createTextOutput(p['hub.challenge']);
  }
  return ContentService.createTextOutput('forbidden');
}

/**
 * Входящие события: Meta (объект с entry) и SendPulse (массив событий,
 * см. раздел «SendPulse» ниже). Секрет в URL общий для обоих.
 */
function doPost(e) {
  // Meta не читает тело ответа и не повторяет доставку по коду ответа,
  // поэтому на любую ошибку отвечаем 200 и пишем в лог — иначе Meta
  // может отписать эндпоинт после серии неудач.
  try {
    if (!e || !e.parameter || e.parameter.s !== prop_('URL_SECRET')) {
      console.warn('Отклонён запрос без валидного секрета');
      return ok_();
    }
    const body = JSON.parse(e.postData.contents);
    if (Array.isArray(body)) {
      body.forEach(function (ev) { handleSendPulse_(ev); });
      return ok_();
    }
    (body.entry || []).forEach(function (entry) {
      (entry.messaging || []).forEach(function (msg) { handleMessaging_(msg); });
    });
  } catch (err) {
    console.error('doPost: ' + err + '\n' + (e && e.postData ? e.postData.contents : ''));
  }
  return ok_();
}

/**
 * Одно событие мессенджера. Интересует только то, у которого есть referral
 * с источником ADS — остальная переписка нам не нужна и в таблицу не идёт.
 */
function handleMessaging_(msg) {
  // referral приходит либо отдельным событием, либо вложенным в message
  const ref = msg.referral || (msg.message && msg.message.referral);
  if (!ref || ref.source !== 'ADS' || !ref.ad_id) return;

  const igsid = msg.sender && msg.sender.id;
  if (!igsid) return;

  const ctx = ref.ads_context_data || {};
  const row = {
    ts: new Date(Number(msg.timestamp) || Date.now()).toISOString(),
    igsid: igsid,
    ad_id: String(ref.ad_id),
    ref: ref.ref || '',
    ad_title: ctx.ad_title || '',
    media_url: ctx.photo_url || ctx.video_url || '',
    first_text: (msg.message && msg.message.text) || '',
    raw: JSON.stringify(msg)
  };
  appendUnique_(row);
}

/**
 * Пишем первое касание и только его.
 *
 * Если человек позже кликнет по другому объявлению, вторая строка не
 * появится: атрибуция здесь по первому касанию (first touch). Так честнее
 * для оценки того, что именно привело человека, и так не задваиваются лиды
 * при сведении с amoCRM, где сделка всё равно одна.
 */
function appendUnique_(row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const seen = sh.getLastRow() > 1
      ? sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); })
      : [];
    if (seen.indexOf(row.igsid) !== -1) return;
    sh.appendRow(HEADERS.map(function (h) { return row[h]; }));
  } finally {
    lock.releaseLock();
  }
}

/* ==================== SendPulse: курс из первого сообщения ==================== */

/*
 * AI-консультант клуба отвечает в Direct из SendPulse. Его глобальный
 * вебхук «Входящие сообщения» шлёт сюда POST с JSON-массивом событий:
 *   [{ service: 'instagram', title: 'incoming_message',
 *      bot: { id, name }, contact: { id, username, name, last_message },
 *      info: { message: ... }, date: <unix, сек> }]
 *
 * Первое сообщение из рекламы — это текст нажатой кнопки-вопроса, и почти
 * всегда он начинается с курса: «Лепка из природной глины: как записаться
 * на пробное?». Из него берём курс и кладём строку в лист «Курсы из
 * Direct». Метку в сделку amoCRM ставит pplTagDirectCourses в проекте
 * «ФБ»: там есть доступ к amoCRM, а сделка к моменту вебхука может ещё
 * не появиться.
 *
 * Пишем каждого, кто написал, — одна строка на человека за SP_WINDOW_DAYS
 * дней, курс в ней есть, если назван: страница «Путь клиента» показывает
 * все новые переписки, а не только рекламные (27.09.2026 новые люди
 * пришли отметками в сторис, без курса, и в таблицу не попали). Строка
 * без курса не мешает записать строку с курсом: человек мог
 * поздороваться, а курс назвать вторым сообщением. Дальше в переписке
 * курс может упоминаться сколько угодно — метка нужна одна.
 */
const SP_SHEET = 'Курсы из Direct';
const SP_HEADERS = ['ts', 'service', 'bot', 'contact_id', 'username', 'name',
  'course', 'prefix', 'text', 'ad_id', 'ad_title', 'status', 'lead_id', 'tries'];
const SP_WINDOW_DAYS = 7;

/*
 * SendPulse сам отличает чаты из рекламы (раздел «Эффективность рекламы»),
 * значит referral от Meta до него доходит. Где именно он лежит в вебхуке,
 * документация не показывает, поэтому ищем ad_id по всему событию, а
 * первые SP_RAW_LIMIT событий кладём как есть в отдельный лист — по ним
 * видно реальную структуру. Лист перестаёт расти сам.
 */
const SP_RAW_SHEET = 'SendPulse: образцы';
const SP_RAW_LIMIT = 30;

/**
 * Словарь курсов: названия — как варианты поля «Курс в заявке» в amoCRM.
 * Порядок важен только при совпадении позиции: частное раньше общего
 * («Нейромалыш» раньше «Нейро»). Основное правило — побеждает курс,
 * названный в тексте первым, потому что кнопка начинается с курса.
 */
const SP_COURSES = [
  ['Minecraft', /minecraft|майнкрафт/i],
  ['Roblox', /roblox|роблокс/i],
  ['Scratch', /scratch|скр[еэ]тч/i],
  ['Python', /python|пайтон|питон/i],
  ['3D Blender', /blender|блендер/i],
  ['Unity', /(?<![a-z])unity|юнити/i],   // не «community»
  ['Godot', /godot|годот/i],
  ['Digital Art', /digital[\s-]*art|диджитал|цифров\S*\s+(рисован|графи|арт|живопис)/i],
  ['TinkerCad', /tinkercad|тинкеркад/i],
  ['App Inventor', /app\s*inventor|апп?\s*инвентор/i],
  ['Старт в IT', /старт\s+в\s+(it|айти)/i],
  ['Робототехника', /робототехн|wedo|лего|lego/i],
  ['Электроника', /электроник/i],
  ['Английский', /англ/i],
  ['Каллиграфия', /каллиграф/i],
  ['Глина', /глин|лепк/i],
  ['Полимерка', /полимер/i],
  ['Песок', /пес(ок|к|оч)/i],
  ['Арт-студия', /арт[\s-]*студи/i],
  ['Рисование', /рисова|рисунк/i],
  ['Почемучка', /почемучк/i],
  ['Говорилка', /говорилк/i],
  ['Живая Азбука', /азбук/i],
  ['Нейромалыш', /нейромалыш/i],
  ['Нейродиагностика', /нейродиагност|диагностик/i],
  ['Нейро', /нейро/i],
  ['Логика', /логик/i],
  ['Математика', /математик/i],
  ['Финансовая грамотность', /финанс|финграм/i],
  ['Взросление', /взрослени/i],
  ['7 навыков', /(7|семь)\s*навык/i],
  ['Каникулы', /каникул|лагер/i],
  ['Интенсив', /интенсив/i]
];

/** Сочетания, которые в amoCRM заведены отдельным курсом. */
const SP_COMBOS = [
  [['Roblox', '3D Blender'], 'Roblox + 3D Blender'],
  [['3D Blender', 'Unity'], '3D Blender + Unity']
];

/**
 * Курс по тексту сообщения: '' если не нашёлся. Чистая функция —
 * гоняется в Node-тестах.
 */
function spCourse_(text) {
  const s = String(text || '');
  if (!s) return '';
  const found = [];
  SP_COURSES.forEach(function (c, order) {
    const m = c[1].exec(s);
    if (m) found.push({ name: c[0], at: m.index, order: order });
  });
  if (!found.length) return '';
  const names = found.map(function (f) { return f.name; });
  for (let i = 0; i < SP_COMBOS.length; i++) {
    const parts = SP_COMBOS[i][0];
    if (parts.every(function (p) { return names.indexOf(p) !== -1; })) return SP_COMBOS[i][1];
  }
  found.sort(function (a, b) { return a.at - b.at || a.order - b.order; });
  return found[0].name;
}

/**
 * Текст до двоеточия, если сообщение похоже на кнопку «Курс: вопрос?».
 * Сохраняем как есть — по нему видно, из какой рекламы кнопка.
 */
function spPrefix_(text) {
  const s = String(text || '');
  const i = s.indexOf(':');
  return i > 0 && i <= 60 ? s.slice(0, i).trim() : '';
}

/**
 * Текст входящего сообщения. Точная вложенность у SendPulse зависит от
 * мессенджера, поэтому перебираем известные места и в конце берём
 * contact.last_message — его SendPulse кладёт всегда.
 */
function spText_(ev) {
  const msg = ev && ev.info && ev.info.message;
  const cd = msg && msg.channel_data;
  const cand = [
    cd && cd.message && cd.message.text && cd.message.text.body,
    cd && cd.message && cd.message.text,
    cd && cd.text,
    msg && msg.text,
    ev && ev.contact && ev.contact.last_message
  ];
  for (let i = 0; i < cand.length; i++) {
    if (typeof cand[i] === 'string' && cand[i].trim()) return cand[i].trim();
  }
  return '';
}

/**
 * Referral рекламы Meta внутри события SendPulse: первый объект с ad_id,
 * где бы он ни лежал. Пустой объект, если это не переписка из рекламы.
 * Чистая функция.
 */
function spReferral_(ev) {
  let found = null;
  (function walk(o, depth) {
    if (found || !o || typeof o !== 'object' || depth > 8) return;
    if (o.ad_id) { found = o; return; }
    Object.keys(o).forEach(function (k) { walk(o[k], depth + 1); });
  })(ev, 0);
  if (!found) return {};
  const ctx = found.ads_context_data || {};
  return { ad_id: String(found.ad_id), ad_title: String(ctx.ad_title || found.ad_title || '') };
}

/** Первые SP_RAW_LIMIT событий как есть — чтобы видеть структуру вебхука. */
function spSaveRaw_(ev) {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  let sh = ss.getSheetByName(SP_RAW_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SP_RAW_SHEET);
    sh.appendRow(['ts', 'title', 'raw']);
    sh.setFrozenRows(1);
  }
  if (sh.getLastRow() > SP_RAW_LIMIT) return;
  sh.appendRow([new Date().toISOString(), ev.title || '', JSON.stringify(ev).slice(0, 45000)]);
}

/** Одно событие SendPulse. */
function handleSendPulse_(ev) {
  if (!ev || ev.title !== 'incoming_message') return;
  const contact = ev.contact || {};
  if (!contact.id) return;
  try { spSaveRaw_(ev); } catch (e) { console.warn('spSaveRaw_: ' + e); }
  const text = spText_(ev);
  const course = spCourse_(text);
  const ref = spReferral_(ev);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = spSheet_();
    const ts = new Date((Number(ev.date) || Date.now() / 1000) * 1000);
    const last = sh.getLastRow();
    if (last > 1) {
      const from = Math.max(2, last - 1999);   // хватит с запасом: ~неделя переписок
      // до колонки course включительно: [ts, service, bot, contact_id, username, name, course]
      const rows = sh.getRange(from, 1, last - from + 1, 7).getValues();
      if (spSeenRecently_(rows, String(contact.id), !!course, ts.getTime())) return;
    }
    sh.appendRow([
      ts.toISOString(),
      ev.service || '',
      (ev.bot && ev.bot.name) || '',
      String(contact.id),
      contact.username || '',
      contact.name || '',
      course,
      spPrefix_(text),
      text.slice(0, 500),
      ref.ad_id || '',
      ref.ad_title || '',
      '', '', 0
    ]);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Был ли уже человек в листе за окно SP_WINDOW_DAYS. Строка без курса не
 * мешает записать строку с курсом — «Здравствуйте» и следом «Minecraft:
 * сколько стоит?» дадут две строки, страница покажет одну, с курсом.
 * Чистая функция: rows — строки листа по колонку course, по порядку записи.
 */
function spSeenRecently_(rows, contactId, hasCourse, now) {
  const edge = now - SP_WINDOW_DAYS * 86400000;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][3]) !== contactId) continue;
    // строки идут по времени: вышли за окно — дальше только старее
    if (new Date(rows[i][0]).getTime() < edge) return false;
    if (!hasCourse || String(rows[i][6] || '')) return true;
  }
  return false;
}

function spSheet_() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  let sh = ss.getSheetByName(SP_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SP_SHEET);
    sh.appendRow(SP_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function sheet_() {
  const ss = SpreadsheetApp.openById(prop_('SHEET_ID'));
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function prop_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Не задано свойство скрипта: ' + name);
  return v;
}

function ok_() {
  return ContentService.createTextOutput('EVENT_RECEIVED');
}
