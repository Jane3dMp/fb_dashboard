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
 * Ставит ежедневные триггеры на выгрузки и сборку витрин.
 *
 * Часы разнесены намеренно: сначала данные, потом витрины. Склеивать всё
 * в одну функцию нельзя — у Apps Script лимит выполнения 6 минут, а в
 * RAW_pays 25 тысяч строк, цепочка оборвалась бы на середине и молча.
 *
 * Имя без подчёркивания на конце: приватные функции не видны в списке
 * запуска редактора, и запустить её вручную было бы нечем.
 *
 * Повторный запуск безопасен — свои прежние триггеры сносим, дублей нет.
 */
function pplSetupDailyTriggers() {
  // backfillAlpha, а не dumpAlfaPay: последняя — диагностика, тянет одну
  // страницу в лог и в таблицу не пишет. И не loadAlphaMonth: та требует
  // месяц аргументом, а триггер аргументы не передаёт.
  var plan = [['runAmoEtl',5],['backfillAlpha',6],['dumpAlfaLinks',7],['buildMart',8],['buildChannel',9],['buildBrands',10],['buildKanikulySverka',11]];
  var want = {};
  plan.forEach(function (p) { want[p[0]] = true; });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (want[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t);
  });
  plan.forEach(function (p) {
    ScriptApp.newTrigger(p[0]).timeBased().atHour(p[1]).everyDays(1).create();
  });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    Logger.log(t.getHandlerFunction());
  });
}

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
  params = params || {};   // чтобы функцию можно было запустить из редактора
  const until = params.until || pplIsoDate_(new Date());
  const since = params.since || pplIsoDate_(pplDaysAgo_(Number(params.days) || 30));

  // Кэш как у остальных дашбордов: запрос ходит в amoCRM и Meta по десятку
  // раз, без кэша страница не укладывается в таймаут и падает с
  // «Failed to fetch». Обход — nocache=1, как в Код.gs.
  const cache = CacheService.getScriptCache();
  const cacheKey = 'ppl_' + since + '_' + until;
  if (params.nocache !== '1') {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }

  const clicks = pplReadClicks_(since, until);
  const leads = pplFetchAmoLeads_(since);
  const spendByAd = pplFetchAdSpend_(since, until);

  const people = pplJoinClicksToLeads_(clicks, leads);
  const ads = pplAggregateByAd_(people, spendByAd);

  const byPlatform = pplFetchSpendByPlatform_(since, until);
  const amoCurrency = pplFetchAmoCurrency_();

  const out = {
    view: 'people',
    since: since,
    until: until,
    updated: new Date().toISOString(),
    matching: pplMatchingMode_(),
    people: people,
    ads: ads,
    channel: pplChannelSummary_(leads, byPlatform, until, amoCurrency, pplFetchPipelines_()),
    profiles: pplFetchSpendByProfile_(spendByAd),
    revenue: pplRevenueFromAlfa_(since, until, byPlatform, amoCurrency)
  };

  // 100 КБ — потолок значения в CacheService. Список людей может его
  // пробить, и тогда просто не кэшируем: терять данные ради кэша нельзя.
  try {
    const json = JSON.stringify(out);
    if (json.length < 100000) cache.put(cacheKey, json, 1800);
  } catch (e) { /* кэш — не то, ради чего стоит ронять ответ */ }

  return out;
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
/** act_-идентификаторы кабинетов из свойства AD_ACCOUNTS («id:Название,...»). */
function pplAdAccounts_() {
  return pplProp_('AD_ACCOUNTS').split(',')
    .map(function (s) { return 'act_' + s.split(':')[0].trim(); })
    .filter(function (a) { return a !== 'act_'; });
}

function pplFetchAdSpend_(since, until) {
  const accounts = pplAdAccounts_();
  const spend = {};

  accounts.forEach(function (acct) {
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
  const out = { instagram: 0, facebook: 0, other: 0, total: 0, currency: '', mixed_currency: false };

  pplAdAccounts_().forEach(function (acct) {
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
 * Расход по Instagram-профилям.
 *
 * У клуба несколько профилей (каникулы и CODDY), но кабинет один, поэтому
 * разделить расход можно только через объявления: у каждого в креативе
 * записан instagram_actor_id — профиль, от имени которого оно крутится.
 * По названиям кампаний делить нельзя: их переименовывают, и отчёт молча
 * начнёт врать.
 *
 * Имена профилей берём из свойства IG_PROFILES в формате
 * «id:Название,id:Название». Профиль без имени показываем по id — лучше
 * непонятная строка, чем потерянные деньги.
 */
function pplFetchSpendByProfile_(spendByAd) {
  const names = {};
  (PropertiesService.getScriptProperties().getProperty('IG_PROFILES') || '')
    .split(',').forEach(function (pair) {
      const i = pair.indexOf(':');
      if (i > 0) names[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    });

  // Спрашиваем креативы только у объявлений, которые реально тратили деньги
  // за период. Обход всех объявлений кабинета занимал столько времени, что
  // запрос не укладывался в таймаут и страница падала с «Failed to fetch».
  const adIds = Object.keys(spendByAd);
  const actorByAd = {};

  // Креатив объявления не меняется, поэтому связку держим в кэше надолго
  // и спрашиваем Meta только про те объявления, которых там ещё нет.
  const cache = CacheService.getScriptCache();
  const cached = cache.getAll(adIds.map(function (id) { return 'igact_' + id; }));
  const missing = [];
  adIds.forEach(function (id) {
    const v = cached['igact_' + id];
    if (v === undefined) missing.push(id);
    else if (v) actorByAd[id] = v;
  });

  for (let i = 0; i < missing.length; i += 25) {
    const chunk = missing.slice(i, i + 25);
    // фигурные скобки в fields обязательно кодировать: UrlFetchApp
    // отвергает такой адрес с «Invalid argument», а не с ошибкой Meta
    const url = 'https://graph.facebook.com/' + FB_API_VERSION + '/' +
      '?ids=' + encodeURIComponent(chunk.join(',')) +
      // спрашиваем оба имени поля: в свежих версиях API профиль лежит в
      // instagram_user_id, в старых — в instagram_actor_id
      '&fields=' + encodeURIComponent('creative{instagram_actor_id,instagram_user_id}') +
      '&access_token=' + encodeURIComponent(pplProp_('FB_TOKEN'));
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) continue;
    const body = JSON.parse(resp.getContentText());
    const toCache = {};
    chunk.forEach(function (id) {
      const cr = (body[id] && body[id].creative) || {};
      const actor = cr.instagram_user_id || cr.instagram_actor_id;
      // пустую строку тоже запоминаем: иначе объявления без профиля будем
      // спрашивать у Meta при каждой загрузке страницы
      toCache['igact_' + id] = actor ? String(actor) : '';
      if (actor) actorByAd[id] = String(actor);
    });
    cache.putAll(toCache, 21600);
  }

  const acc = {};
  Object.keys(spendByAd).forEach(function (adId) {
    const actor = actorByAd[adId] || '';
    const key = actor || '(профиль не определён)';
    if (!acc[key]) acc[key] = { profile_id: actor, profile: names[actor] || key, spend: 0, clicks: 0, ads: 0 };
    acc[key].spend += spendByAd[adId].spend;
    acc[key].clicks += spendByAd[adId].clicks;
    acc[key].ads++;
  });

  return Object.keys(acc).map(function (k) { return acc[k]; })
    .sort(function (a, b) { return b.spend - a.spend; });
}

/** Названия воронок, чтобы показывать «Каникулы», а не 10453398. */
function pplFetchPipelines_() {
  const url = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4/leads/pipelines';
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pplProp_('AMO_TOKEN') },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) return {};
  const out = {};
  (((JSON.parse(resp.getContentText())._embedded) || {}).pipelines || [])
    .forEach(function (p) { out[p.id] = p.name; });
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
function pplChannelSummary_(leads, spendByPlatform, until, amoCurrency, pipelineNames) {
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

  // Разрез по воронкам — только для заявок из Instagram: вопрос «что дала
  // реклама» бессмыслен для сделок, пришедших звонком или от действующих
  // клиентов. Именно здесь видно каникулы отдельно от регулярных занятий.
  const byPipeline = {};
  inPeriod.forEach(function (l) {
    if (!/instagram/i.test(l.source || '')) return;
    const id = l.pipeline_id;
    if (!byPipeline[id]) {
      byPipeline[id] = {
        pipeline_id: id,
        pipeline: (pipelineNames && pipelineNames[id]) || String(id),
        leads: 0, won: 0, lost: 0, open: 0, revenue: 0, won_without_price: 0
      };
    }
    const p = byPipeline[id];
    p.leads++;
    if (l.status === 'won') {
      p.won++;
      p.revenue += l.price;
      if (!l.price) p.won_without_price++;
    } else if (l.status === 'lost') p.lost++;
    else p.open++;
  });

  return {
    spend: spendByPlatform,
    sources: sources,
    pipelines: Object.keys(byPipeline).map(function (k) { return byPipeline[k]; })
      .sort(function (a, b) { return b.leads - a.leads; }),
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

/* ============ 3b. Выручка из Альфы (настоящие деньги) ============ */

/**
 * Группа направления по воронке.
 *
 * BRAND_MAP объявлена в build_brands.gs и видна здесь: файлы проекта делят
 * одну глобальную область. Берём её, а не свою копию, — иначе «Путь клиента»
 * и дашборд направлений однажды разойдутся в цифрах.
 * null означает воронку вне карты (например «Тест») — такие не считаем.
 */
function pplBrand_(pipeline) {
  const key = String(pipeline || '').trim().toLowerCase();
  const map = (typeof BRAND_MAP !== 'undefined') ? BRAND_MAP : {};
  return map[key] || null;
}

/** Лист по имени или null — чтобы отсутствие витрины не роняло страницу. */
function pplSheet_(name) {
  const sh = SpreadsheetApp.openById(pplProp_('SHEET_ID')).getSheetByName(name);
  return (sh && sh.getLastRow() > 1) ? sh : null;
}

/** Строки листа как массив объектов по заголовку. */
function pplRows_(name) {
  const sh = pplSheet_(name);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  const header = values.shift().map(function (h) { return String(h).trim(); });
  return values.map(function (r) {
    const o = {};
    header.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

/**
 * Идентификатор клиента Альфы из ссылки в карточке amoCRM.
 *
 * Формат ссылки не гарантирован, поэтому берём последнюю группу цифр —
 * она и есть id клиента. Доля распознанных ссылок возвращается наружу,
 * чтобы на странице было видно, если связка перестала работать.
 */
function pplAlfaCustomerId_(url) {
  const digits = String(url || '').match(/\d+/g);
  return digits && digits.length ? digits[digits.length - 1] : '';
}

/** Платежи Альфы, сгруппированные по клиенту. */
function pplPaysByCustomer_() {
  const acc = {};
  pplRows_('RAW_pays').forEach(function (r) {
    const id = String(r.customer_id || '').trim();
    if (!id) return;
    const d = r.document_date instanceof Date
      ? pplIsoDate_(r.document_date)
      : String(r.document_date || '').slice(0, 10);
    if (!acc[id]) acc[id] = [];
    acc[id].push({ date: d, income: Number(r.income || 0) });
  });
  return acc;
}

/**
 * Выручка по заявкам из Instagram — по фактическим оплатам в AlfaCRM.
 *
 * Считаем так: берём заявки периода с источником Instagram, у каждой через
 * alfa_url находим клиента Альфы и суммируем его платежи, сделанные НЕ РАНЬШЕ
 * даты заявки. Платёж до появления заявки рекламой не вызван — это уже
 * действующий клиент, и приписывать его объявлению нельзя.
 *
 * Период считается по дате заявки, а не по дате платежа: вопрос звучит
 * «что принесли заявки этого периода», а не «сколько денег пришло в кассу».
 * Поэтому на коротком окне выручка всегда занижена — заявки не дозрели.
 */
function pplRevenueFromAlfa_(since, until, spendByPlatform, amoCurrency) {
  const paysBy = pplPaysByCustomer_();
  const leads = pplRows_('RAW_leads').filter(function (l) {
    const d = l.created_at instanceof Date
      ? pplIsoDate_(l.created_at)
      : String(l.created_at || '').slice(0, 10);
    l._date = d;
    return d >= since && d <= until && /instagram/i.test(String(l.source || ''));
  });

  const byBrand = {};
  let withAlfa = 0, paidCustomers = 0, revenue = 0;
  const seenCustomers = {};

  leads.forEach(function (l) {
    const brand = pplBrand_(l.pipeline);
    const key = brand || '(вне карты направлений)';
    if (!byBrand[key]) byBrand[key] = { brand: key, leads: 0, with_alfa: 0, paid: 0, revenue: 0 };
    const b = byBrand[key];
    b.leads++;

    const cid = pplAlfaCustomerId_(l.alfa_url);
    if (!cid) return;
    withAlfa++;
    b.with_alfa++;

    // один клиент может прийти несколькими заявками — деньги считаем один раз
    if (seenCustomers[cid]) return;
    seenCustomers[cid] = true;

    const sum = (paysBy[cid] || []).reduce(function (s, p) {
      return p.date >= l._date ? s + p.income : s;
    }, 0);
    if (sum > 0) {
      paidCustomers++;
      revenue += sum;
      b.paid++;
      b.revenue += sum;
    }
  });

  const spend = spendByPlatform.instagram;
  const adCur = spendByPlatform.currency;
  const rate = Number(PropertiesService.getScriptProperties().getProperty('FX_RATE') || 0);
  const same = adCur && amoCurrency && adCur === amoCurrency;
  const comparable = !spendByPlatform.mixed_currency && (same || rate > 0);
  const spendInAmo = same ? spend : (rate > 0 ? spend * rate : null);

  return {
    source: 'alfa',
    leads: leads.length,
    with_alfa: withAlfa,
    matched_share: leads.length ? withAlfa / leads.length : 0,
    paid_customers: paidCustomers,
    revenue: revenue,
    cac: comparable && paidCustomers ? spendInAmo / paidCustomers : null,
    roas: comparable && spendInAmo ? revenue / spendInAmo : null,
    brands: Object.keys(byBrand).map(function (k) { return byBrand[k]; })
      .sort(function (a, b) { return b.revenue - a.revenue || b.leads - a.leads; })
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
