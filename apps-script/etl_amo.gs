/**
 * etl_amo.gs v2 — сделки amoCRM → лист RAW_leads
 * ------------------------------------------------
 * Читает поля по фактическим id (подтверждены через /custom_fields):
 *   Источник заявки  — поле СДЕЛКИ, id 1654275 (select)
 *   utm_source       — поле СДЕЛКИ, id 1648721
 *   utm_campaign     — поле СДЕЛКИ, id 1648719
 *   utm_content      — поле СДЕЛКИ, id 1648715
 *   fbclid           — поле СДЕЛКИ, id 1648751
 *   Телефон          — поле КОНТАКТА, id 1648707 (multitext, берём первый номер)
 *   Ссылка на Alpha  — поле КОНТАКТА, id 1652617 (мост к Alpha CRM)
 *
 * Script Properties: AMO_SUBDOMAIN, AMO_TOKEN, SHEET_ID
 * Запуск: runAmoEtl()
 */

var SHEET_LEADS = 'RAW_leads';

// id полей amoCRM
var F = {
  source:       1654275,  // сделка: Источник заявки
  utm_source:   1648721,
  utm_campaign: 1648719,
  utm_content:  1648715,
  fbclid:       1648751,
  phone:        1648707,   // контакт: Phone
  alfa_url:     1652617    // контакт: (Х) Ссылка на alfaCRM
};

function amoProps_() {
  var p = PropertiesService.getScriptProperties();
  return {
    subdomain: p.getProperty('AMO_SUBDOMAIN'),
    token: p.getProperty('AMO_TOKEN'),
    sheetId: p.getProperty('SHEET_ID')
  };
}

function amoFetch_(path, cfg) {
  var url = 'https://' + cfg.subdomain + '.amocrm.ru/api/v4' + path;
  var resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + cfg.token },
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code === 204) return null;
  if (code === 401) throw new Error('amoCRM 401: токен недействителен');
  if (code >= 400) throw new Error('amoCRM ' + code + ': ' + resp.getContentText().slice(0, 300));
  return JSON.parse(resp.getContentText());
}

/** Справочник воронок и статусов */
function loadPipelines_(cfg) {
  var data = amoFetch_('/leads/pipelines', cfg);
  var map = {};
  if (!data || !data._embedded) return map;
  data._embedded.pipelines.forEach(function (pl) {
    var st = {};
    (pl._embedded && pl._embedded.statuses || []).forEach(function (s) { st[s.id] = s.name; });
    map[pl.id] = { name: pl.name, statuses: st };
  });
  return map;
}

/** Значение поля по id из custom_fields_values (первое значение) */
function fieldById_(cfv, id) {
  if (!cfv) return '';
  for (var i = 0; i < cfv.length; i++) {
    if (cfv[i].field_id === id) {
      var v = cfv[i].values || [];
      return v.length ? (v[0].value || '') : '';
    }
  }
  return '';
}

/** Первый номер телефона из multitext-поля контакта */
function phoneFromContact_(cfv) {
  if (!cfv) return '';
  for (var i = 0; i < cfv.length; i++) {
    if (cfv[i].field_id === F.phone) {
      var v = cfv[i].values || [];
      return v.length ? (v[0].value || '') : '';
    }
  }
  return '';
}

/** Нормализация телефона в E.164 под Беларусь (+375). Возвращает '' для мусора. */
function normalizePhone_(raw) {
  if (!raw) return '';
  var d = String(raw).replace(/\D/g, '');
  if (!d) return '';
  // 80291234567 (11 цифр, начинается с 80) → 375291234567
  if (d.length === 11 && d.slice(0, 2) === '80') d = '375' + d.slice(2);
  // 291234567 (9 цифр, локальный) → 375291234567
  else if (d.length === 9) d = '375' + d;
  // уже с кодом страны 375XXXXXXXXX (12 цифр) — оставляем
  // всё остальное подозрительно короткое — отбраковываем
  if (d.length < 11) return '';           // отсекает мусор вроде 335, 32423
  return '+' + d;
}

function runAmoEtl() {
  var cfg = amoProps_();
  if (!cfg.subdomain || !cfg.token || !cfg.sheetId) {
    throw new Error('Заданы не все свойства: AMO_SUBDOMAIN, AMO_TOKEN, SHEET_ID');
  }

  var pipelines = loadPipelines_(cfg);
  var rows = [];
  var page = 1;
  var limit = 250;

  while (true) {
    var data = amoFetch_('/leads?with=contacts&limit=' + limit + '&page=' + page, cfg);
    if (!data || !data._embedded || !data._embedded.leads || !data._embedded.leads.length) break;
    var leads = data._embedded.leads;

    // id первых контактов сделок
    var contactIds = [];
    leads.forEach(function (l) {
      var cs = (l._embedded && l._embedded.contacts) || [];
      if (cs.length) contactIds.push(cs[0].id);
    });
    var contactData = fetchContacts_(cfg, contactIds); // {id: {phone, alfa}}

    leads.forEach(function (l) {
      var pl = pipelines[l.pipeline_id] || { name: '', statuses: {} };
      var cs = (l._embedded && l._embedded.contacts) || [];
      var cid = cs.length ? cs[0].id : null;
      var cd = cid ? (contactData[cid] || {}) : {};

      rows.push([
        new Date(l.created_at * 1000),
        cd.phone || '',
        fieldById_(l.custom_fields_values, F.source),
        fieldById_(l.custom_fields_values, F.utm_source),
        fieldById_(l.custom_fields_values, F.utm_campaign),
        fieldById_(l.custom_fields_values, F.utm_content),
        fieldById_(l.custom_fields_values, F.fbclid),
        pl.name,
        pl.statuses[l.status_id] || String(l.status_id),
        cd.alfa || '',
        l.id,
        // id контакта — второй мост к Альфе: у части клиентов Альфы в поле
        // web лежит ссылка на этот контакт (см. RAW_alfa_customers)
        cid || ''
      ]);
    });

    if (leads.length < limit) break;
    page++;
    if (page > 200) break;
  }

  writeSheetById_(cfg.sheetId, SHEET_LEADS, [
    'created_at', 'phone_e164', 'source',
    'utm_source', 'utm_campaign', 'utm_content', 'fbclid',
    'pipeline', 'stage', 'alfa_url', 'lead_id', 'contact_id'
  ], rows);

  Logger.log('RAW_leads обновлён: ' + rows.length + ' сделок');
}

/** Контакты чанками: телефон (нормализованный) + ссылка на Alpha */
function fetchContacts_(cfg, ids) {
  var out = {};
  var uniq = ids.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  for (var i = 0; i < uniq.length; i += 50) {
    var chunk = uniq.slice(i, i + 50);
    var q = chunk.map(function (id) { return 'filter[id][]=' + id; }).join('&');
    var data = amoFetch_('/contacts?' + q + '&limit=50', cfg);
    if (data && data._embedded && data._embedded.contacts) {
      data._embedded.contacts.forEach(function (c) {
        out[c.id] = {
          phone: normalizePhone_(phoneFromContact_(c.custom_fields_values)),
          alfa: fieldById_(c.custom_fields_values, F.alfa_url)
        };
      });
    }
  }
  return out;
}

function writeSheetById_(sheetId, name, header, rows) {
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clearContents();
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
}