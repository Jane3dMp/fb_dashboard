/**
 * Сквозная аналитика: склейка «клик по объявлению → человек → сделка → деньги».
 *
 * Этот файл добавляется в СУЩЕСТВУЮЩИЙ проект Apps Script (тот, что уже
 * отдаёт дашбордам JSON). В его doGet нужно добавить ветку в том же стиле,
 * что и остальные:
 *
 *     if (p.view === 'people') {
 *       return ContentService.createTextOutput(JSON.stringify(buildPeople(p)))
 *         .setMimeType(ContentService.MimeType.JSON);
 *     }
 *
 * Три источника, которые здесь сходятся:
 *   1. лист «Клики»  — кто кликнул и по какому объявлению (пишет webhook.gs)
 *   2. amoCRM        — что стало со сделкой этого человека
 *   3. Meta Ads API  — сколько денег стоило это объявление
 *
 * --- Настройка (Свойства скрипта) ---
 * Все нужные свойства в проекте уже есть и используются другими файлами:
 *   SHEET_ID        — таблица, в неё же webhook.gs пишет лист «Клики»
 *   AMO_SUBDOMAIN, AMO_TOKEN — доступ к amoCRM
 *   FB_TOKEN, AD_ACCOUNTS    — доступ к Meta Ads
 *
 * Добавить нужно только одно, и то опционально:
 *   AMO_IGSID_FIELD — id пользовательского поля контакта с IGSID (см. ниже)
 *
 * Сделки берутся напрямую из amoCRM, а не из витрины build_mart: витрина
 * агрегирует, а здесь нужен каждый лид поимённо. Если витрину когда-нибудь
 * расширят до уровня отдельных сделок, этот запрос можно будет заменить
 * чтением листа.
 */

/** Сделка считается выигранной/проигранной по системным статусам amoCRM. */
const AMO_WON = 142;
const AMO_LOST = 143;

/**
 * Поле сделки в amoCRM, в котором лежит канал обращения («Instagram»,
 * «Звонок» и т.п.). Ищем по названию, а не по id: id у каждого аккаунта
 * свой, а название стабильно. Если название однажды поменяют — можно
 * задать свойство AMO_SOURCE_FIELD с числовым id и оно победит.
 */
const AMO_SOURCE_FIELD_NAME = 'Источник заявки';

/**
 * Окно для запасного сопоставления по времени, часы.
 * Используется только если IGSID в amoCRM недоступен.
 */
const TIME_MATCH_WINDOW_H = 6;

function buildPeople(params) {
  const until = params.until || pplIsoDate_(new Date());
  const since = params.since || pplIsoDate_(pplDaysAgo_(Number(params.days) || 30));

  const clicks = pplReadClicks_(since, until);
  const leads = pplFetchAmoLeads_(since);
  const spendByAd = pplFetchAdSpend_(since, until);

  const people = pplJoinClicksToLeads_(clicks, leads);
  const ads = pplAggregateByAd_(people, spendByAd);

  return {
    view: 'people',
    since: since,
    until: until,
    updated: new Date().toISOString(),
    matching: pplMatchingMode_(),
    people: people,
    ads: ads,
    channel: pplChannelSummary_(
      leads, pplFetchSpendByPlatform_(since, until), until, pplFetchAmoCurrency_()
    )
  };
}

/* ==================== 1. Клики ==================== */

function pplReadClicks_(since, until) {
  const sh = SpreadsheetApp.openById(pplProp_('SHEET_ID')).getSheetByName('Клики');
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
function pplFetchAmoLeads_(since) {
  const base = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4/leads';
  const from = Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000);
  const out = [];

  for (let page = 1; page <= 50; page++) {
    const url = base + '?limit=250&page=' + page +
      '&with=contacts&filter[created_at][from]=' + from;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pplProp_('AMO_TOKEN') },
      muteHttpExceptions: true
    });
    // 204 — страницы кончились, это штатный конец обхода, не ошибка
    if (resp.getResponseCode() === 204) break;
    if (resp.getResponseCode() !== 200) {
      throw new Error('amoCRM ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
    }
    const body = JSON.parse(resp.getContentText());
    const chunk = (body._embedded && body._embedded.leads) || [];
    chunk.forEach(function (l) { out.push(pplNormalizeLead_(l)); });
    if (chunk.length < 250) break;
  }
  return pplEnrichWithContacts_(out);
}

function pplNormalizeLead_(l) {
  return {
    id: l.id,
    name: l.name || '',
    created_at: new Date(l.created_at * 1000).toISOString(),
    status_id: l.status_id,
    pipeline_id: l.pipeline_id,
    price: l.price || 0,
    status: l.status_id === AMO_WON ? 'won' : (l.status_id === AMO_LOST ? 'lost' : 'open'),
    contact_ids: ((l._embedded && l._embedded.contacts) || []).map(function (c) { return c.id; }),
    source: pplLeadSource_(l),
    igsid: ''
  };
}

/** Канал обращения из пользовательского поля сделки. Пусто — значит не заполнен. */
function pplLeadSource_(l) {
  const override = Number(PropertiesService.getScriptProperties().getProperty('AMO_SOURCE_FIELD') || 0);
  const fields = l.custom_fields_values || [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const hit = override ? f.field_id === override : f.field_name === AMO_SOURCE_FIELD_NAME;
    if (hit && f.values && f.values[0]) return String(f.values[0].value || '');
  }
  return '';
}

/**
 * Догружаем контакты, чтобы достать IGSID из пользовательского поля.
 *
 * Штатная интеграция amoCRM с Instagram сама IGSID никуда не кладёт — поле
 * нужно завести руками и заполнять роботом/виджетом. Если поле не настроено,
 * молча уходим на сопоставление по времени: лучше приблизительный ответ
 * с честной пометкой, чем пустая страница.
 */
function pplEnrichWithContacts_(leads) {
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
    const url = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4/contacts?limit=250' +
      batch.map(function (id) { return '&filter[id][]=' + id; }).join('');
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + pplProp_('AMO_TOKEN') },
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

/**
 * Расход по каждому объявлению за период.
 *
 * AD_ACCOUNTS в этом проекте хранится в формате «id:Название,id:Название»,
 * поэтому берём часть до двоеточия и добавляем префикс act_.
 */
function pplFetchAdSpend_(since, until) {
  const accounts = pplProp_('AD_ACCOUNTS').split(',').map(function (s) {
    return 'act_' + s.split(':')[0].trim();
  });
  const spend = {};

  accounts.forEach(function (acct) {
    if (acct === 'act_') return;
    const url = 'https://graph.facebook.com/' + FB_API_VERSION + '/' + acct + '/insights' +
      '?level=ad&fields=ad_id,ad_name,campaign_name,spend,clicks,impressions' +
      '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) +
      '&limit=500&access_token=' + encodeURIComponent(pplProp_('FB_TOKEN'));
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

/**
 * Расход с разбивкой по площадкам.
 *
 * Нужен отдельно от расхода по объявлениям: кампании Meta крутятся и в
 * Instagram, и в Facebook, а сопоставлять мы будем с заявками, у которых
 * в amoCRM стоит источник «Instagram». Складывать весь расход кабинета с
 * заявками только из Instagram — значит занижать окупаемость.
 */
function pplFetchSpendByPlatform_(since, until) {
  const accounts = pplProp_('AD_ACCOUNTS').split(',').map(function (s) {
    return 'act_' + s.split(':')[0].trim();
  });
  const out = { instagram: 0, facebook: 0, other: 0, total: 0, currency: '', mixed_currency: false };

  accounts.forEach(function (acct) {
    if (acct === 'act_') return;
    const url = 'https://graph.facebook.com/' + FB_API_VERSION + '/' + acct + '/insights' +
      '?level=account&fields=spend,account_currency&breakdowns=publisher_platform' +
      '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) +
      '&limit=100&access_token=' + encodeURIComponent(pplProp_('FB_TOKEN'));
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return;
    ((JSON.parse(resp.getContentText()).data) || []).forEach(function (r) {
      const v = Number(r.spend || 0);
      const p = String(r.publisher_platform || '').toLowerCase();
      const cur = String(r.account_currency || '');
      // кабинеты могут вестись в разных валютах — тогда суммировать их нельзя
      if (cur) {
        if (!out.currency) out.currency = cur;
        else if (out.currency !== cur) out.mixed_currency = true;
      }
      out.total += v;
      if (p === 'instagram') out.instagram += v;
      else if (p === 'facebook') out.facebook += v;
      else out.other += v;
    });
  });
  return out;
}

/**
 * Валюта сумм в amoCRM. Нужна, чтобы не делить рубли на доллары.
 *
 * Не роняем расчёт, если запрос не прошёл: лучше показать суммы без
 * ROAS, чем не показать ничего.
 */
function pplFetchAmoCurrency_() {
  const url = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4/account';
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pplProp_('AMO_TOKEN') },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return '';
  return String(JSON.parse(resp.getContentText()).currency || '').toUpperCase();
}

/**
 * Окупаемость на уровне канала: расход в Instagram против сделок, у которых
 * в amoCRM источник — Instagram.
 *
 * Это огрубление: канал целиком, без разбивки по объявлениям. Разбивка
 * требует связки «клик → человек», а её Meta отдаёт только после проверки
 * приложения. Зато эти цифры честные и доступны сразу.
 *
 * Отдельно считаем выигранные сделки с нулевым бюджетом: если менеджеры не
 * проставляют сумму, выручка окажется занижена, и об этом честнее сказать
 * прямо на странице, чем показывать заниженный ROAS как факт.
 */
function pplChannelSummary_(leads, spendByPlatform, until, amoCurrency) {
  const inPeriod = leads.filter(function (l) { return l.created_at.slice(0, 10) <= until; });

  const bySource = {};
  inPeriod.forEach(function (l) {
    const src = l.source || '(не указан)';
    if (!bySource[src]) {
      bySource[src] = { source: src, leads: 0, won: 0, lost: 0, open: 0, revenue: 0, won_without_price: 0 };
    }
    const s = bySource[src];
    s.leads++;
    if (l.status === 'won') {
      s.won++;
      s.revenue += l.price;
      if (!l.price) s.won_without_price++;
    } else if (l.status === 'lost') s.lost++;
    else s.open++;
  });

  const sources = Object.keys(bySource).map(function (k) { return bySource[k]; })
    .sort(function (a, b) { return b.leads - a.leads; });

  // название источника могут написать по-разному, поэтому ищем по вхождению
  const igKey = Object.keys(bySource).filter(function (k) { return /instagram/i.test(k); })[0];
  const ig = igKey ? bySource[igKey] : { leads: 0, won: 0, lost: 0, open: 0, revenue: 0, won_without_price: 0 };
  const spend = spendByPlatform.instagram;

  // Расход приходит из Meta, выручка — из amoCRM, и валюты у них разные.
  // Делить одно на другое без курса нельзя: получится красивое, но
  // бессмысленное число. Курс задаётся свойством FX_RATE — сколько единиц
  // валюты amoCRM в одной единице валюты рекламного кабинета.
  const adCur = spendByPlatform.currency;
  const rate = Number(PropertiesService.getScriptProperties().getProperty('FX_RATE') || 0);
  const sameCurrency = adCur && amoCurrency && adCur === amoCurrency;
  const comparable = !spendByPlatform.mixed_currency && (sameCurrency || rate > 0);
  // расход, приведённый к валюте выручки
  const spendInAmo = sameCurrency ? spend : (rate > 0 ? spend * rate : null);

  return {
    spend: spendByPlatform,
    sources: sources,
    source_filled: inPeriod.length ? (inPeriod.length - (bySource['(не указан)'] || { leads: 0 }).leads) / inPeriod.length : 0,
    currency: {
      ads: adCur,
      amo: amoCurrency || '',
      same: !!sameCurrency,
      rate: rate > 0 ? rate : null,
      comparable: comparable,
      mixed_ad_accounts: !!spendByPlatform.mixed_currency
    },
    instagram: {
      spend: spend,
      leads: ig.leads,
      won: ig.won,
      lost: ig.lost,
      open: ig.open,
      revenue: ig.revenue,
      won_without_price: ig.won_without_price,
      cost_per_lead: ig.leads ? spend / ig.leads : null,
      // CAC и ROAS считаем только когда суммы сопоставимы
      cac: comparable && ig.won ? spendInAmo / ig.won : null,
      roas: comparable && spendInAmo ? ig.revenue / spendInAmo : null,
      conv: ig.leads ? ig.won / ig.leads : null
    }
  };
}

/* ==================== 4. Склейка ==================== */

function pplMatchingMode_() {
  return PropertiesService.getScriptProperties().getProperty('AMO_IGSID_FIELD')
    ? 'igsid' : 'time';
}

/**
 * Каждому клику ищем сделку. Два прохода, и порядок принципиален.
 *
 * Сначала разбираем точные совпадения по IGSID и помечаем эти сделки
 * занятыми. Только потом для оставшихся кликов работает запасной путь —
 * по времени: сделки, созданные в течение TIME_MATCH_WINDOW_H после клика.
 * Если сделать это в один проход, ранний клик может увести по времени
 * сделку, которая по идентификатору принадлежит другому человеку.
 *
 * Запасной путь работает и когда поле IGSID настроено: пока оно заполнено
 * не у всех (а в переходный период это norma), одного точного совпадения
 * мало, и без времени страница осталась бы почти пустой.
 *
 * Если кандидатов по времени несколько — не гадаем, помечаем как
 * неоднозначное. Пусть на дашборде будет видно, сколько данных
 * получено приблизительно.
 */
function pplJoinClicksToLeads_(clicks, leads) {
  const byIgsid = {};
  leads.forEach(function (l) { if (l.igsid) byIgsid[l.igsid] = l; });

  const usedLeadIds = {};
  const matches = new Array(clicks.length);

  // проход 1 — точные совпадения
  clicks.forEach(function (c, i) {
    const lead = byIgsid[c.igsid];
    if (lead && !usedLeadIds[lead.id]) {
      usedLeadIds[lead.id] = true;
      matches[i] = { lead: lead, how: 'igsid' };
    }
  });

  // проход 2 — по времени, из того, что осталось свободным
  clicks.forEach(function (c, i) {
    if (matches[i]) return;
    const t = new Date(c.ts).getTime();
    const candidates = leads.filter(function (l) {
      if (usedLeadIds[l.id]) return false;
      const dt = new Date(l.created_at).getTime() - t;
      return dt >= 0 && dt <= TIME_MATCH_WINDOW_H * 3600 * 1000;
    });
    if (candidates.length === 1) {
      usedLeadIds[candidates[0].id] = true;
      matches[i] = { lead: candidates[0], how: 'time' };
    } else if (candidates.length > 1) {
      matches[i] = { lead: null, how: 'ambiguous' };
    }
  });

  return clicks.map(function (c, i) {
    const m = matches[i] || { lead: null, how: 'none' };
    const lead = m.lead;
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
      matched: m.how
    };
  });
}

/** Сводка по объявлениям: сколько стоило и что принесло. */
function pplAggregateByAd_(people, spendByAd) {
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

function pplIsoDate_(d) { return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd'); }
function pplDaysAgo_(n) { return new Date(Date.now() - n * 86400000); }

// Хелперы с префиксом ppl, чтобы не столкнуться с функциями из Код.gs.
function pplProp_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Не задано свойство скрипта: ' + name);
  return v;
}
