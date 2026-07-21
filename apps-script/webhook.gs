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

/** Входящие события мессенджера. */
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
