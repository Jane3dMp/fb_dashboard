/**
 * Сквозная аналитика: склейка «клик по объявлению → человек → сделка → деньги».
 *
 * Этот файл добавляется в СУЩЕСТВУЮЩИЙ проект Apps Script (тот, что уже
 * отдаёт дашбордам JSON). В его doGet нужно добавить ветку:
 *
 *     if (e.parameter.view === 'people') return json_(buildPeople(e.parameter));
 *
 * Три источника, которые здесь сходятся:
 *   1. лист «Клики»  — кто кликнул и по какому объявлению (пишет webhook.gs)
 *   2. amoCRM        — что стало со сделкой этого человека
 *   3. Meta Ads API  — сколько денег стоило это объявление
 *
 * --- Настройка (Свойства скрипта) ---
 *   CLICKS_SHEET_ID   — таблица, в которую пишет webhook.gs
 *   AMO_SUBDOMAIN     — поддомен amoCRM (без .amocrm.ru)
 *   AMO_TOKEN         — долгоживущий токен доступа
 *   AMO_IGSID_FIELD   — id пользовательского поля контакта с IGSID (см. ниже)
 *   META_TOKEN        — токен Meta Ads с доступом к ads_read
 *   META_ACCOUNTS     — id кабинетов через запятую, в формате act_123,act_456
 */

/** Сделка считается выигранной/проигранной по системным статусам amoCRM. */
const AMO_WON = 142;
const AMO_LOST = 143;

/**
 * Окно для запасного сопоставления по времени, часы.
 * Используется только если IGSID в amoCRM недоступен.
 */
const TIME_MATCH_WINDOW_H = 6;

function buildPeople(params) {
  const until = params.until || isoDate_(new Date());
  const since = params.since || isoDate_(daysAgo_(Number(params.days) || 30));

  const clicks = readClicks_(since, until);
  const leads = fetchAmoLeads_(since);
  const spendByAd = fetchAdSpend_(since, until);

  const people = joinClicksToLeads_(clicks, leads);
  const ads = aggregateByAd_(people, spendByAd);

  return {
    view: 'people',
    since: since,
    until: until,
    updated: new Date().toISOString(),
    matching: matchingMode_(),
    people: people,
    ads: ads
  };
}

/* ==================== 1. Клики ==================== */

function readClicks_(since, until) {
  const sh = SpreadsheetApp.openById(prop_('CLICKS_SHEET_ID')).getSheetByName('Клики');
  if (!sh || sh.getLastRow() < 2) return [];

  const values = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  return values.map(function (r) {
    return {
      ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
      igsid: String(r[1]),
      ad_id: String(r[2]),
      ref: String(r[3] || ''),
      ad_title: String(r[4] || ''),
      first_text: String(r[6] || '')
    };
  }).filter(function (c) {
    const d = c.ts.slice(0, 10);
    return c.igsid && d >= since && d <= until;
  });
}

/* ==================== 2. amoCRM ==================== */

/** Сделки, созданные начиная с since, вместе с контактами. */
function fetchAmoLeads_(since) {
  const base = 'https://' + prop_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4/leads';
  const from = Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000);
  const out = [];

  for (let page = 1; page <= 50; page++) {
    const url = base + '?limit=250&page=' + page +
      '&with=contacts&filter[created_at][from]=' + from;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + prop_('AMO_TOKEN') },
      muteHttpExceptions: true
    });
    // 204 — страницы кончились, это штатный конец обхода, не ошибка
    if (resp.getResponseCode() === 204) break;
    if (resp.getResponseCode() !== 200) {
      throw new Error('amoCRM ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
    }
    const body = JSON.parse(resp.getContentText());
    const chunk = (body._embedded && body._embedded.leads) || [];
    chunk.forEach(function (l) { out.push(normalizeLead_(l)); });
    if (chunk.length < 250) break;
  }
  return enrichWithContacts_(out);
}

function normalizeLead_(l) {
  return {
    id: l.id,
    name: l.name || '',
    created_at: new Date(l.created_at * 1000).toISOString(),
    status_id: l.status_id,
    pipeline_id: l.pipeline_id,
    price: l.price || 0,
    status: l.status_id === AMO_WON ? 'won' : (l.status_id === AMO_LOST ? 'lost' : 'open'),
    contact_ids: ((l._embedded && l._embedded.contacts) || []).map(function (c) { return c.id; }),
    igsid: ''
  };
}

/**
 * Догружаем контакты, чтобы достать IGSID из пользовательского поля.
 *
 * Штатная интеграция amoCRM с Instagram сама IGSID никуда не кладёт — поле
 * нужно завести руками и заполнять роботом/виджетом. Если поле не настроено,
 * молча уходим на сопоставление по времени: лучше приблизительный ответ
 * с честной пометкой, чем пустая страница.
 */
function enrichWithContacts_(leads) {
  const fieldId = Number(PropertiesService.getScriptProperties().getProperty('AMO_IGSID_FIELD') || 0);
  if (!fieldId) return leads;

  const ids = [];
  leads.forEach(function (l) {
    l.contact_ids.forEach(function (id) { if (ids.indexOf(id) === -1) ids.push(id); });
  });
  if (!ids.length) return leads;

  const igsidByContact = {};
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const url = 'https://' + prop_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4/contacts?limit=250' +
      batch.map(function (id) { return '&filter[id][]=' + id; }).join('');
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + prop_('AMO_TOKEN') },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) continue;
    const contacts = (JSON.parse(resp.getContentText())._embedded || {}).contacts || [];
    contacts.forEach(function (c) {
      (c.custom_fields_values || []).forEach(function (f) {
        if (f.field_id === fieldId && f.values && f.values[0]) {
          igsidByContact[c.id] = String(f.values[0].value);
        }
      });
    });
  }

  leads.forEach(function (l) {
    for (let i = 0; i < l.contact_ids.length; i++) {
      const v = igsidByContact[l.contact_ids[i]];
      if (v) { l.igsid = v; break; }
    }
  });
  return leads;
}

/* ==================== 3. Meta Ads ==================== */

/** Расход по каждому объявлению за период. */
function fetchAdSpend_(since, until) {
  const accounts = prop_('META_ACCOUNTS').split(',').map(function (s) { return s.trim(); });
  const spend = {};

  accounts.forEach(function (acct) {
    if (!acct) return;
    const url = 'https://graph.facebook.com/v21.0/' + acct + '/insights' +
      '?level=ad&fields=ad_id,ad_name,campaign_name,spend,clicks,impressions' +
      '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) +
      '&limit=500&access_token=' + encodeURIComponent(prop_('META_TOKEN'));
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return; // кабинет мог отвалиться по правам — не роняем всё
    ((JSON.parse(resp.getContentText()).data) || []).forEach(function (r) {
      spend[r.ad_id] = {
        ad_name: r.ad_name || '',
        campaign_name: r.campaign_name || '',
        spend: Number(r.spend || 0),
        clicks: Number(r.clicks || 0),
        impressions: Number(r.impressions || 0)
      };
    });
  });
  return spend;
}

/* ==================== 4. Склейка ==================== */

function matchingMode_() {
  return PropertiesService.getScriptProperties().getProperty('AMO_IGSID_FIELD')
    ? 'igsid' : 'time';
}

/**
 * Каждому клику ищем сделку.
 *
 * Точный путь — по IGSID, если поле в amoCRM настроено. Запасной — по времени:
 * берём сделки, созданные в течение TIME_MATCH_WINDOW_H после клика. Если
 * кандидат ровно один, считаем совпадением; если несколько, не гадаем и
 * помечаем как неоднозначное — пусть на дашборде будет видно, сколько
 * данных получено приблизительно.
 */
function joinClicksToLeads_(clicks, leads) {
  const byIgsid = {};
  leads.forEach(function (l) { if (l.igsid) byIgsid[l.igsid] = l; });

  const usedLeadIds = {};
  return clicks.map(function (c) {
    let lead = byIgsid[c.igsid] || null;
    let how = lead ? 'igsid' : 'none';

    if (!lead && matchingMode_() === 'time') {
      const t = new Date(c.ts).getTime();
      const candidates = leads.filter(function (l) {
        if (usedLeadIds[l.id]) return false;
        const dt = new Date(l.created_at).getTime() - t;
        return dt >= 0 && dt <= TIME_MATCH_WINDOW_H * 3600 * 1000;
      });
      if (candidates.length === 1) { lead = candidates[0]; how = 'time'; }
      else if (candidates.length > 1) { how = 'ambiguous'; }
    }
    if (lead) usedLeadIds[lead.id] = true;

    return {
      igsid: c.igsid,
      clicked_at: c.ts,
      ad_id: c.ad_id,
      ad_title: c.ad_title,
      first_text: c.first_text,
      name: lead ? lead.name : '',
      amo_lead_id: lead ? lead.id : null,
      status: lead ? lead.status : 'no_deal',
      revenue: lead && lead.status === 'won' ? lead.price : 0,
      matched: how
    };
  });
}

/** Сводка по объявлениям: сколько стоило и что принесло. */
function aggregateByAd_(people, spendByAd) {
  const acc = {};
  people.forEach(function (p) {
    if (!acc[p.ad_id]) acc[p.ad_id] = { ad_id: p.ad_id, wrote: 0, deals: 0, won: 0, revenue: 0 };
    const a = acc[p.ad_id];
    a.wrote++;
    if (p.amo_lead_id) a.deals++;
    if (p.status === 'won') { a.won++; a.revenue += p.revenue; }
  });

  // объявления, которые крутились, но не принесли ни одного диалога,
  // тоже должны быть видны — иначе слитый бюджет останется незамеченным
  Object.keys(spendByAd).forEach(function (adId) {
    if (!acc[adId]) acc[adId] = { ad_id: adId, wrote: 0, deals: 0, won: 0, revenue: 0 };
  });

  return Object.keys(acc).map(function (adId) {
    const a = acc[adId];
    const s = spendByAd[adId] || { ad_name: '', campaign_name: '', spend: 0, clicks: 0, impressions: 0 };
    return {
      ad_id: adId,
      ad_name: s.ad_name,
      campaign_name: s.campaign_name,
      spend: s.spend,
      clicks: s.clicks,
      wrote: a.wrote,
      deals: a.deals,
      won: a.won,
      revenue: a.revenue,
      cac: a.won ? s.spend / a.won : null,
      roas: s.spend ? a.revenue / s.spend : null
    };
  }).sort(function (x, y) { return y.spend - x.spend; });
}

/* ==================== Утилиты ==================== */

function isoDate_(d) { return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); }
function daysAgo_(n) { return new Date(Date.now() - n * 86400000); }

// Если в проекте уже есть свой prop_ — удалить этот, Apps Script не допускает
// две функции с одним именем в пределах проекта.
function prop_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Не задано свойство скрипта: ' + name);
  return v;
}
