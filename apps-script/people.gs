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
 * RAW_pays под тридцать тысяч строк, цепочка оборвалась бы на середине
 * и молча.
 *
 * Имя без подчёркивания на конце: приватные функции не видны в списке
 * запуска редактора, и запустить её вручную было бы нечем.
 *
 * Повторный запуск безопасен — свои прежние триггеры сносим, дублей нет.
 */
function pplSetupDailyTriggers() {
  // Платежи собирает pplRebuildPays, а не backfillAlpha: у той фильтр по
  // датам не работал (Альфа ждёт date_from, а не document_date_from), и
  // каждый «месяц» дописывал в лист всю историю целиком ещё раз.
  // dumpAlfaLinks из расписания убран — это диагностика, пишет только в лог.
  var plan = [['pplEtlAlfaCustomers',4],['runAmoEtl',5],['pplRebuildPays',6],['buildMart',8],['buildChannel',9],['buildBrands',10],['buildKanikulySverka',11]];
  // то, что раньше стояло в расписании, а теперь из него выведено
  var retired = ['backfillAlpha', 'dumpAlfaLinks'];
  var drop = {};
  plan.forEach(function (p) { drop[p[0]] = true; });
  retired.forEach(function (n) { drop[n] = true; });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (drop[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t);
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

  const byPlatform = pplFetchSpendByPlatform_(since, until);
  const amoCurrency = pplFetchAmoCurrency_();
  const pipelineNames = pplFetchPipelines_();
  // таблица «Кто написал в Direct» — бонус: не читается лист или не ответил
  // amo, страница выйдет без неё, а не упадёт
  let direct = [];
  try { direct = pplDirectRows_(since, until); } catch (e) { Logger.log('Кто написал в Direct: ' + e); }
  const revenue = pplRevenueFromAlfa_(since, until, byPlatform, amoCurrency, pipelineNames, direct);

  // таблица «По объявлениям» и расход по курсам — из людей Direct, у
  // которых ядро уже посчитало сделки и деньги
  const toAmo = pplToAmo_(byPlatform, amoCurrency);
  const adStats = pplDirectAdStats_(revenue.direct.rows, spendByAd);
  const ads = pplAggregateByAd_(people, spendByAd, adStats, toAmo);
  revenue.by_course = pplCourseSpend_(revenue.by_course, spendByAd, adStats.courseOf, toAmo);
  revenue.direct = pplDirectCap_(revenue.direct, PPL_DIRECT_ROWS_MAX);

  const out = {
    view: 'people',
    since: since,
    until: until,
    updated: new Date().toISOString(),
    matching: pplMatchingMode_(),
    people: people,
    ads: ads,
    ads_total: pplAdsTotal_(ads, adStats, toAmo),
    // откуда колонки «Написали…Выручка»: meta — клики, ad — ID объявления
    // от SendPulse, course — по курсу
    ads_attribution: people.length ? 'meta' : adStats.mode,
    channel: pplChannelSummary_(leads, byPlatform, until, amoCurrency, pipelineNames),
    profiles: pplFetchSpendByProfile_(spendByAd),
    revenue: revenue
  };

  // 100 КБ — потолок значения в CacheService. Список людей может его
  // пробить, и тогда просто не кэшируем: терять данные ради кэша нельзя.
  // 10 минут, а не 30: деньги теперь добирают живую дельту из amo и Альфы,
  // и долгий кэш съедал бы её актуальность.
  try {
    const json = JSON.stringify(out);
    if (json.length < 100000) cache.put(cacheKey, json, 600);
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
/**
 * Связка «объявление → Instagram-профиль» и имена профилей — общий хелпер
 * для «Пути клиента» и «Дней таргета». Возвращает { actorByAd, names }.
 */
function pplIgProfileMap_(adIds) {
  const names = {};
  (PropertiesService.getScriptProperties().getProperty('IG_PROFILES') || '')
    .split(',').forEach(function (pair) {
      const i = pair.indexOf(':');
      if (i > 0) names[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    });

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

  // Имена профилей: свойство IG_PROFILES побеждает, остальных спрашиваем
  // у Meta (username отдаётся тем же токеном). Ответ кэшируем надолго —
  // имя профиля не меняется. Если Meta не отдаст (нет прав) — останется id.
  const actors = [];
  Object.keys(actorByAd).forEach(function (adId) {
    const a = actorByAd[adId];
    if (a && !names[a] && actors.indexOf(a) === -1) actors.push(a);
  });
  if (actors.length) {
    const cachedNames = cache.getAll(actors.map(function (id) { return 'igname_' + id; }));
    const missingNames = [];
    actors.forEach(function (id) {
      const v = cachedNames['igname_' + id];
      if (v === undefined) missingNames.push(id);
      else if (v) names[id] = v;
    });
    if (missingNames.length) {
      const url = 'https://graph.facebook.com/' + FB_API_VERSION + '/' +
        '?ids=' + encodeURIComponent(missingNames.join(',')) +
        '&fields=' + encodeURIComponent('username,name') +
        '&access_token=' + encodeURIComponent(pplProp_('FB_TOKEN'));
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() === 200) {
        const body = JSON.parse(resp.getContentText());
        const toCache = {};
        missingNames.forEach(function (id) {
          const p = body[id] || {};
          const nm = p.username ? '@' + p.username : (p.name || '');
          toCache['igname_' + id] = nm; // пустоту тоже кэшируем, чтобы не спрашивать зря
          if (nm) names[id] = nm;
        });
        cache.putAll(toCache, 21600);
      }
    }
  }

  return { actorByAd: actorByAd, names: names };
}

function pplFetchSpendByProfile_(spendByAd) {
  // Спрашиваем креативы только у объявлений, которые реально тратили деньги
  // за период. Обход всех объявлений кабинета занимал столько времени, что
  // запрос не укладывался в таймаут и страница падала с «Failed to fetch».
  const map = pplIgProfileMap_(Object.keys(spendByAd));

  const acc = {};
  Object.keys(spendByAd).forEach(function (adId) {
    const actor = map.actorByAd[adId] || '';
    const key = actor || '(профиль не определён)';
    if (!acc[key]) acc[key] = { profile_id: actor, profile: map.names[actor] || key, spend: 0, clicks: 0, ads: 0 };
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

/**
 * Дата из ячейки листа в виде ГГГГ-ММ-ДД, откуда бы она ни пришла.
 *
 * В листах даты живут в трёх видах: объект Date (Sheets распарсил ячейку),
 * строка «ДД.ММ.ГГГГ» (так отдаёт Альфа) и ISO-строка (так пишет etl_amo).
 * Сравнивать периоды можно только приведя всё к одному виду; иначе
 * «31.05.2026» >= «2026-05-01» сравнится по алфавиту и молча соврёт.
 * Без Utilities: этому хелперу нужно работать и в Node-тестах.
 */
function pplAnyIso_(v) {
  // не instanceof: Date из другого контекста выполнения (vm в тестах)
  // им не распознаётся, а поведение нужно одинаковое везде
  if (v && typeof v.getFullYear === 'function') {
    return v.getFullYear() + '-' + ('0' + (v.getMonth() + 1)).slice(-2) + '-' + ('0' + v.getDate()).slice(-2);
  }
  const s = String(v || '');
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  const dot = s.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (dot) return dot[3] + '-' + dot[2] + '-' + dot[1];
  return '';
}

/**
 * Нормализация телефона к +375XXXXXXXXX — та же логика, что в normalizePhone_
 * из etl_amo.gs, которая заполняет phone_e164 в RAW_leads. Мост между заявкой
 * и клиентом Альфы держится на том, что обе стороны нормализованы одинаково.
 * Своя копия с префиксом ppl — чтобы не зависеть от чужого файла и гоняться
 * в Node.
 */
function pplNormPhone_(raw) {
  if (!raw) return '';
  var d = String(raw).replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d.slice(0, 2) === '80') d = '375' + d.slice(2);
  else if (d.length === 9) d = '375' + d;
  if (d.length < 11) return '';
  return '+' + d;
}

/* --- Доступ к API Альфы. Свои хелперы с префиксом ppl: похожие есть в
 * kanikuly_sverka.gs и Etl alpha.gs, но сигнатуры у них другие, а общая
 * глобальная область проекта уже приводила к столкновениям имён. --- */

function pplAlfaSession_() {
  const host = PropertiesService.getScriptProperties().getProperty('ALFA_HOST') || 'proznanie4eee.s20.online';
  const resp = UrlFetchApp.fetch('https://' + host + '/v2api/auth/login', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ email: pplProp_('ALFA_EMAIL'), api_key: pplProp_('ALFA_APIKEY') }),
    muteHttpExceptions: true
  });
  const token = JSON.parse(resp.getContentText()).token;
  if (!token) throw new Error('Альфа не пустила: ' + resp.getContentText().slice(0, 150));
  return { host: host, token: token };
}

function pplAlfaPage_(session, branch, entity, body) {
  const resp = UrlFetchApp.fetch('https://' + session.host + '/v2api/' + branch + '/' + entity + '/index', {
    method: 'post', contentType: 'application/json',
    headers: { 'X-ALFACRM-TOKEN': session.token },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Альфа ' + entity + '/' + branch + ': ' + resp.getResponseCode() + ' ' + pplBriefBody_(resp.getContentText()));
  }
  return JSON.parse(resp.getContentText());
}

/**
 * Начало ответа для текста ошибки. HTML-страницу ужимаем до заголовка и
 * текста без разметки: 25.09.2026 Альфа ответила такой страницей с кодом
 * 400, и в журнал попала только её шапка — что случилось, не понять.
 */
function pplBriefBody_(text) {
  const s = String(text || '');
  if (!/^\s*</.test(s)) return s.slice(0, 150);
  const title = ((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const body = s.replace(/<(head|script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return ((title ? title + ': ' : '') + body).slice(0, 200);
}

/**
 * pplAlfaPage_ с повтором. Альфа изредка отвечает страницей ошибки
 * посреди выгрузки (25.09.2026 — 400 на 37-й секунде), а UrlFetch —
 * сетевым сбоем; страницу пробуем ещё дважды, прежде чем сдаться.
 */
function pplAlfaPageRetry_(session, branch, entity, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      return pplAlfaPage_(session, branch, entity, body);
    } catch (e) {
      if (attempt >= 3) throw e;
      Utilities.sleep(attempt * 5000);
    }
  }
}

/**
 * Филиалы, из которых берём данные. Филиал 3 («Якубовского, 90») сюда
 * включать нельзя: он зеркалит филиал 1 — те же клиенты и те же платежи
 * с теми же id, сумма задвоится. Проверено прямым сравнением по API.
 */
function pplAlfaBranches_() {
  return (PropertiesService.getScriptProperties().getProperty('ALFA_BRANCHES') || '1,2')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

/**
 * Ежедневная выгрузка клиентов Альфы → лист RAW_alfa_customers.
 *
 * Это вторая половина моста «заявка → деньги»: связь заявки с клиентом
 * строится по телефону, а телефоны клиентов живут только в Альфе.
 * Поле контакта amoCRM «(X) Ссылка на alfaCRM» пусто у всех заявок,
 * а обратное поле Альфы custom_url_amo_client пусто у всех клиентов —
 * проверено по API, надеяться на них нельзя.
 *
 * Попутно сохраняем id контакта amoCRM из стандартного поля web (его
 * заполняет интеграция примерно у пятой части клиентов) — пригодится,
 * если однажды в RAW_leads появятся id контактов для точной сверки.
 */
function pplEtlAlfaCustomers() {
  const session = pplAlfaSession_();
  const rows = [];
  const seen = {};
  pplAlfaBranches_().forEach(function (branch) {
    for (var page = 0; page < 200; page++) {
      // is_study: 2 — и ученики, и лиды. Без него customer/index молча отдаёт
      // только учеников, а записанные на пробное/абонемент часто ещё лиды —
      // так терялся Бейманов Макар (#4994) и ещё полсотни человек на филиал.
      const d = pplAlfaPage_(session, branch, 'customer', { page: page, is_study: 2 });
      const items = d.items || [];
      items.forEach(function (c) {
        if (seen[c.id]) return; // клиент может числиться в нескольких филиалах
        seen[c.id] = true;
        const phones = (c.phone || []).map(pplNormPhone_).filter(function (v, i, arr) {
          return v && arr.indexOf(v) === i;
        });
        const amoContact = ((c.web || []).map(function (u) {
          const m = String(u).match(/amocrm\.ru\/contacts\/detail\/(\d+)/);
          return m ? m[1] : '';
        }).filter(Boolean))[0] || '';
        rows.push([c.id, (c.branch_ids || [branch]).join(';'), phones.join(';'), amoContact, String(c.created_at || ''), String(c.name || '')]);
      });
      if (items.length < 50) break;
    }
  });

  const ss = SpreadsheetApp.openById(pplProp_('SHEET_ID'));
  const sh = ss.getSheetByName('RAW_alfa_customers') || ss.insertSheet('RAW_alfa_customers');
  sh.clearContents();
  const header = ['customer_id', 'branches', 'phones', 'amo_contact_id', 'created_at', 'name'];
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  Logger.log('RAW_alfa_customers: ' + rows.length + ' клиентов');
}

/**
 * Ежедневный полный пересбор листа RAW_pays из Альфы.
 *
 * Именно пересбор, а не догрузка месяцев, и вот почему. Старая схема
 * (loadAlphaMonth + backfillAlpha) сломана дважды: фильтр по датам она
 * передавала как document_date_from/to, которые Альфа молча игнорирует
 * (рабочие имена — date_from/date_to), поэтому каждый «месяц» тянул всю
 * историю целиком; а отметка загруженного месяца сравнивала строку
 * «2026-07» с датой, в которую Sheets превратил ячейку, никогда не
 * совпадала — и текущий месяц дописывался заново каждый день. Итог в
 * листе: история в трёх экземплярах. Полный пересбор самовосстанавливается
 * и не требует вести учёт месяцев.
 *
 * Только доходы (pay_type_id 1), дедупликация по pay_id: id платежа
 * в Альфе глобальный, у филиалов-зеркал он один и тот же.
 *
 * Пересбор идёт порциями. Страниц по 50 платежей уже под шестьсот
 * (сентябрь 2026), и один проход перестал укладываться в 6 минут —
 * лимит запуска Apps Script: обрывался по таймауту день за днём, и лист
 * застыл на платежах по 8.09. Теперь скачанные страницы копятся в
 * служебном листе PPL_PAYS_NEXT_SHEET, а запуск, у которого кончилось
 * время, оставляет продолжение разовому триггеру pplRebuildPaysNext.
 * RAW_pays переписывается одним махом, когда собраны все филиалы, —
 * до этого дашборды видят вчерашний лист целиком, как и раньше.
 *
 * Запуск руками из редактора начинает пересбор заново.
 */
function pplRebuildPays() {
  pplPaysStep_(true);
}

/** Продолжение пересбора RAW_pays. Триггер на него ставит сам пересбор. */
function pplRebuildPaysNext() {
  pplPaysStep_(false);
}

/**
 * Служебный лист пересбора, скрытый. В A1 — состояние в JSON, со второй
 * строки — скачанные страницы: [номер филиала в списке, страница,
 * сколько платежей пришло, JSON строк RAW_pays].
 */
const PPL_PAYS_NEXT_SHEET = 'RAW_pays_next';
const PPL_PAYS_HEADER = ['document_date', 'customer_id', 'income', 'branch', 'pay_item_id', 'payer_name', 'pay_id'];
/** Потолок страниц на филиал — на случай, если Альфа перестанет понимать page. */
const PPL_PAYS_MAX_PAGES = 800;
/** Столько запуск качает страницы; остаток до 6 минут — на запись листа. */
const PPL_PAYS_BUDGET_MS = 4 * 60000;
/** Продолжение — не раньше, чем текущий запуск закончится в любом случае. */
const PPL_PAYS_NEXT_DELAY_MS = 7 * 60000;
/** Столько запусков даём одному пересбору; дальше — до утреннего триггера. */
const PPL_PAYS_MAX_RUNS = 12;
/** Страниц между записями в служебный лист: оборвётся запуск — перекачаем не больше. */
const PPL_PAYS_FLUSH_EVERY = 20;

/**
 * Один запуск пересбора: порция страниц, а если собрано всё — запись
 * RAW_pays. fresh — начать заново (утренний триггер, ручной запуск).
 */
function pplPaysStep_(fresh) {
  const t0 = Date.now();
  const lock = LockService.getScriptLock();
  // два запуска разом перемешали бы страницы в служебном листе
  if (!lock.tryLock(5000)) {
    Logger.log('RAW_pays: пересбор уже идёт в другом запуске');
    return;
  }
  try {
    const ss = SpreadsheetApp.openById(pplProp_('SHEET_ID'));
    let stage = ss.getSheetByName(PPL_PAYS_NEXT_SHEET);
    if (!stage) {
      stage = ss.insertSheet(PPL_PAYS_NEXT_SHEET);
      stage.hideSheet();
    }

    let job = pplPaysJob_(stage);
    if (fresh) {
      stage.clearContents();
      job = { active: true, started: new Date().toISOString(), branches: pplAlfaBranches_(), runs: 0 };
    } else if (!job || !job.active) {
      pplPaysDropNext_();
      return;
    }
    job.runs++;
    if (job.runs > PPL_PAYS_MAX_RUNS) {
      job.active = false;
      pplPaysSaveJob_(stage, job);
      pplPaysDropNext_();
      throw new Error('RAW_pays: пересбор не уложился в ' + PPL_PAYS_MAX_RUNS +
        ' запусков, лист не перезаписан. Последняя ошибка: ' + (job.error || 'нет'));
    }
    pplPaysSaveJob_(stage, job);
    // Продолжение ставим до работы, а не после: если запуск оборвёт лимит
    // времени, до кода после цикла дело не дойдёт, а триггер уже стоит.
    pplPaysDropNext_();
    ScriptApp.newTrigger('pplRebuildPaysNext').timeBased().after(PPL_PAYS_NEXT_DELAY_MS).create();

    // где остановились — видно по последней скачанной странице
    let row = stage.getLastRow() + 1;
    const tail = row > 2 ? stage.getRange(row - 1, 1, 1, 3).getValues()[0] : null;
    const from = tail ? pplPaysNextPos_(Number(tail[0]), Number(tail[1]), Number(tail[2])) : { b: 0, page: 0 };

    const session = pplAlfaSession_();
    const res = pplPaysCollect_(from, job.branches,
      function (branch, page) {
        return pplAlfaPageRetry_(session, branch, 'pay', { page: page, pay_type_id: 1 });
      },
      function () { return Date.now() - t0 < PPL_PAYS_BUDGET_MS; },
      function (pages) {
        stage.getRange(row, 1, pages.length, 4).setValues(pages);
        row += pages.length;
      });

    const at = res.pos.b < job.branches.length
      ? 'филиал ' + job.branches[res.pos.b] + ', стр. ' + res.pos.page : 'конец';
    Logger.log('RAW_pays: запуск ' + job.runs + ' — ' + res.pages + ' стр. за ' +
      Math.round((Date.now() - t0) / 1000) + ' с, остановились: ' + at);
    if (res.error) {
      job.error = String(res.error).slice(0, 300);
      pplPaysSaveJob_(stage, job);
      throw res.error; // продолжение уже стоит — начнёт с этой же страницы
    }
    if (res.pos.b < job.branches.length) return; // остальное — в следующем запуске

    const rows = row > 2 ? pplPaysAssemble_(stage.getRange(2, 1, row - 2, 4).getValues()) : [];
    // Если Альфа вдруг отдала подозрительно мало, лист не трогаем: пусть
    // лучше останутся вчерашние данные, чем пустая витрина.
    if (rows.length < 1000) {
      job.active = false;
      job.error = 'Альфа отдала всего ' + rows.length + ' платежей';
      pplPaysSaveJob_(stage, job);
      pplPaysDropNext_();
      throw new Error('Альфа отдала всего ' + rows.length + ' платежей — лист не перезаписываем');
    }

    const sh = ss.getSheetByName('RAW_pays') || ss.insertSheet('RAW_pays');
    sh.clearContents();
    sh.getRange(1, 1, 1, PPL_PAYS_HEADER.length).setValues([PPL_PAYS_HEADER]);
    sh.getRange(2, 1, rows.length, PPL_PAYS_HEADER.length).setValues(rows);

    stage.clearContents();
    pplPaysSaveJob_(stage, {
      active: false, started: job.started, done: new Date().toISOString(),
      runs: job.runs, rows: rows.length
    });
    pplPaysDropNext_();
    Logger.log('RAW_pays: ' + rows.length + ' платежей из филиалов ' + job.branches.join(',') +
      ', запусков: ' + job.runs);
  } finally {
    lock.releaseLock();
  }
}

/** Состояние пересбора из A1 служебного листа; нет или битое — null. */
function pplPaysJob_(stage) {
  try {
    return JSON.parse(String(stage.getRange(1, 1).getValue() || ''));
  } catch (e) {
    return null;
  }
}

function pplPaysSaveJob_(stage, job) {
  stage.getRange(1, 1).setValue(JSON.stringify(job));
}

/** Снять триггеры продолжения — и уже сработавший, и ждущий. */
function pplPaysDropNext_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pplRebuildPaysNext') ScriptApp.deleteTrigger(t);
  });
}

/**
 * Качает страницы платежей с позиции from ({b: номер филиала в списке,
 * page}), пока hasTime() разрешает, и сдаёт их в flush строками
 * служебного листа. Сеть и часы приходят снаружи — функция чистая и
 * гоняется в Node-тестах. Если страница так и не скачалась, позиция
 * остаётся на ней, чтобы следующий запуск начал с неё же.
 */
function pplPaysCollect_(from, branches, fetchPage, hasTime, flush) {
  let pos = from;
  let buf = [];
  let pages = 0;
  let error = null;
  while (pos.b < branches.length && hasTime()) {
    const branch = branches[pos.b];
    let items;
    try {
      items = (fetchPage(branch, pos.page) || {}).items || [];
    } catch (e) {
      error = e;
      break;
    }
    const rows = [];
    items.forEach(function (it) {
      const r = pplPayRow_(it, branch);
      if (r) rows.push(r);
    });
    buf.push([pos.b, pos.page, items.length, JSON.stringify(rows)]);
    pages++;
    if (buf.length >= PPL_PAYS_FLUSH_EVERY) {
      flush(buf);
      buf = [];
    }
    pos = pplPaysNextPos_(pos.b, pos.page, items.length);
  }
  if (buf.length) flush(buf);
  return { pos: pos, pages: pages, error: error };
}

/** Какую страницу качать следующей: неполная страница — филиал кончился. */
function pplPaysNextPos_(b, page, count) {
  if (count < 50 || page + 1 >= PPL_PAYS_MAX_PAGES) return { b: b + 1, page: 0 };
  return { b: b, page: page + 1 };
}

/** Платёж Альфы → строка RAW_pays (колонки PPL_PAYS_HEADER); не доход — null. */
function pplPayRow_(it, branch) {
  if (it.pay_type_id !== 1) return null; // страховка на случай поломки фильтра
  return [
    it.document_date,
    it.customer_id,
    Number(it.income || 0),
    branch,
    it.pay_item_id || '',
    it.payer_name || '',
    it.id
  ];
}

/**
 * Страницы из служебного листа → строки RAW_pays в порядке скачивания.
 * Платёж, который попался дважды (филиал-зеркало или сдвиг страниц:
 * Альфа отдаёт новые платежи первыми, и пришедший во время пересбора
 * сдвигает остальные), берётся один раз — по pay_id, первым.
 */
function pplPaysAssemble_(pages) {
  const out = [];
  const seen = {};
  pages.forEach(function (p) {
    JSON.parse(String(p[3] || '[]')).forEach(function (r) {
      const id = r[6];
      if (id && seen[id]) return;
      if (id) seen[id] = true;
      out.push(r);
    });
  });
  return out;
}

/**
 * Чистое ядро расчёта выручки: (заявки, клиенты Альфы, платежи) → цифры.
 * Отделено от чтения листов, чтобы гоняться в Node-тестах.
 *
 * Мост между заявкой и клиентом Альфы трёхступенчатый, от точного к общему:
 *   1) ссылка на Альфу из карточки amo (alfa_url) — сейчас пуста у всех,
 *      но если поле начнут заполнять, связка подхватится сама;
 *   2) id контакта amo: у части клиентов Альфы интеграция кладёт ссылку
 *      на контакт в поле web (колонка amo_contact_id в RAW_alfa_customers);
 *   3) телефон: phone_e164 заявки против нормализованных номеров клиента.
 * По одному телефону может найтись несколько клиентов (семья: дети
 * заведены отдельными карточками) — деньги каждого считаются один раз.
 *
 * Платежи клиента суммируются начиная с даты заявки: платёж раньше заявки
 * рекламой не вызван, это действующий клиент. Период — по дате заявки,
 * а не платежа: вопрос «что принесли заявки этого периода». Поэтому на
 * коротком окне выручка всегда занижена — заявки не дозрели.
 */
function pplAlfaRevenueCore_(leads, customers, pays, since, until, direct) {
  // телефон → клиенты с этим номером; контакт amo → клиенты с этой ссылкой
  const byPhone = {};
  const byContact = {};
  const namesById = {};
  customers.forEach(function (c) {
    const cid = String(c.customer_id);
    namesById[cid] = String(c.name || '');
    String(c.phones || '').split(';').forEach(function (ph) {
      if (!ph) return;
      if (!byPhone[ph]) byPhone[ph] = [];
      byPhone[ph].push(cid);
    });
    const ac = String(c.amo_contact_id || '').trim();
    if (ac) {
      if (!byContact[ac]) byContact[ac] = [];
      byContact[ac].push(cid);
    }
  });

  // клиент → платежи; дедупликация по pay_id — филиалы-зеркала Альфы
  // отдают один платёж под одним id, задваивать его нельзя
  const paysBy = {};
  const seenPay = {};
  pays.forEach(function (r) {
    const id = String(r.customer_id || '').trim();
    if (!id) return;
    const payId = String(r.pay_id || '');
    if (payId) {
      if (seenPay[payId]) return;
      seenPay[payId] = true;
    }
    if (!paysBy[id]) paysBy[id] = [];
    paysBy[id].push({ date: pplAnyIso_(r.document_date), income: Number(r.income || 0) });
  });

  // все заявки периода: сводные метрики считаются по Instagram (вопрос
  // страницы — окупаемость рекламы), а разрез по источникам — по всем
  const inPeriod = leads.filter(function (l) {
    const d = pplAnyIso_(l.created_at);
    l._date = d;
    return d >= since && d <= until;
  });
  const igLeads = inPeriod.filter(function (l) {
    return /instagram/i.test(String(l.source || ''));
  });

  /** Клиенты Альфы, к которым ведёт заявка: ссылка → контакт → телефон. */
  function customersOf(l) {
    const linked = pplAlfaCustomerId_(l.alfa_url);
    if (linked) return [linked];
    const contact = String(l.contact_id || '').trim();
    if (contact && byContact[contact]) return byContact[contact];
    const phone = pplNormPhone_(l.phone_e164);
    return (phone && byPhone[phone]) || [];
  }

  /** Платежи клиента с даты заявки. */
  function paysSince(cid, date) {
    let sum = 0;
    (paysBy[cid] || []).forEach(function (p) {
      if (p.date && p.date >= date) sum += p.income;
    });
    return sum;
  }

  const byBrand = {};
  let withPhone = 0, withAlfa = 0, paidCustomers = 0, revenue = 0;
  const seenCustomers = {};
  // пофамильный список: кто именно оплатил и сколько принёс с даты заявки
  const paidList = [];

  igLeads.forEach(function (l) {
    const brand = pplBrand_(l.pipeline);
    const key = brand || '(вне карты направлений)';
    if (!byBrand[key]) byBrand[key] = { brand: key, leads: 0, with_alfa: 0, paid: 0, revenue: 0 };
    const b = byBrand[key];
    b.leads++;

    if (pplNormPhone_(l.phone_e164)) withPhone++;

    const ids = customersOf(l);
    if (!ids.length) return;

    withAlfa++;
    b.with_alfa++;

    // один клиент может прийти несколькими заявками — деньги считаем один раз
    let sum = 0, hasNew = false;
    ids.forEach(function (cid) {
      if (seenCustomers[cid]) return;
      seenCustomers[cid] = true;
      hasNew = true;
      const cSum = paysSince(cid, l._date);
      sum += cSum;
      if (cSum > 0) {
        paidList.push({
          customer_id: cid,
          name: namesById[cid] || ('клиент #' + cid),
          brand: key,
          lead_date: l._date,
          revenue: cSum
        });
      }
    });
    if (hasNew && sum > 0) {
      paidCustomers++;
      revenue += sum;
      b.paid++;
      b.revenue += sum;
    }
  });

  // Разрез по всем источникам — те же правила, что и выше, но клиент
  // дедуплицируется внутри источника: пришедший и звонком, и из Instagram
  // попадёт в обе строки, потому что строка отвечает на вопрос «сколько
  // денег принесли пришедшие отсюда», а не делит клиента между каналами.
  function slice(rows, keyOf) {
    const acc = {};
    const seen = {};
    rows.forEach(function (l) {
      const key = keyOf(l);
      if (!acc[key]) acc[key] = { key: key, leads: 0, with_alfa: 0, paid: 0, revenue: 0 };
      const s = acc[key];
      s.leads++;
      const ids = customersOf(l);
      if (!ids.length) return;
      s.with_alfa++;
      let sum = 0, hasNew = false;
      ids.forEach(function (cid) {
        if (seen[key + '|' + cid]) return;
        seen[key + '|' + cid] = true;
        hasNew = true;
        sum += paysSince(cid, l._date);
      });
      if (hasNew && sum > 0) { s.paid++; s.revenue += sum; }
    });
    return Object.keys(acc).map(function (k) { return acc[k]; })
      .sort(function (a, b) { return b.leads - a.leads; });
  }

  const bySource = slice(inPeriod, function (l) {
    return String(l.source || '').trim() || '(не указан)';
  }).map(function (s) { return { source: s.key, leads: s.leads, with_alfa: s.with_alfa, paid: s.paid, revenue: s.revenue }; });

  const byPipeline = slice(igLeads, function (l) {
    return String(l.pipeline || '').trim() || '(без воронки)';
  }).map(function (s) { return { pipeline: s.key, leads: s.leads, with_alfa: s.with_alfa, paid: s.paid, revenue: s.revenue }; });

  // Курс из первого сообщения в Direct: его кладёт в utm_campaign
  // pplTagDirectCourses. У заявок из Instagram других UTM не бывает —
  // они приходят из переписки, а не с сайта, так что поле не спорит
  // с настоящими метками.
  const byCourse = slice(igLeads, function (l) {
    return String(l.utm_campaign || '').trim() || PPL_NO_COURSE;
  }).map(function (s) { return { course: s.key, leads: s.leads, with_alfa: s.with_alfa, paid: s.paid, revenue: s.revenue }; });

  // Кто написал в Direct (строки из pplDirectRows_): тот же мост к Альфе,
  // что и выше. Деньги — только у сделки, заведённой на эту переписку: у
  // старой сделки действующего клиента оплаты идут за прежние занятия, и
  // приписать их рекламе значило бы соврать.
  const leadById = {};
  leads.forEach(function (l) { if (l.lead_id) leadById[String(l.lead_id)] = l; });
  const directOut = (direct || []).map(function (r) {
    const out = {
      ts: r.ts, account: r.account, name: r.name, course: r.course, text: r.text,
      ad_id: r.ad_id || '', lead_id: r.lead_id, pipeline: r.pipeline, stage: r.stage, outcome: r.outcome,
      reason: r.reason, client: r.client, with_alfa: false, revenue: 0
    };
    const l = leadById[String(r.lead_id || '')];
    if (!l) return out;
    const ids = customersOf(l);
    out.with_alfa = ids.length > 0;
    if (!r.client) {
      const date = pplAnyIso_(l.created_at);
      ids.forEach(function (cid) { out.revenue += paysSince(cid, date); });
    }
    return out;
  });

  return {
    leads: igLeads.length,
    with_phone: withPhone,
    with_alfa: withAlfa,
    matched_share: igLeads.length ? withAlfa / igLeads.length : 0,
    paid_customers: paidCustomers,
    revenue: revenue,
    brands: Object.keys(byBrand).map(function (k) { return byBrand[k]; })
      .sort(function (a, b) { return b.revenue - a.revenue || b.leads - a.leads; }),
    by_source: bySource,
    by_pipeline: byPipeline,
    by_course: byCourse,
    paid_list: paidList.sort(function (a, b) { return b.revenue - a.revenue; }),
    direct: directOut
  };
}

/**
 * Слияние утреннего листа с живой дельтой: строки дельты заменяют листовые
 * с тем же ключом, новые добавляются. Чистая функция — гоняется в Node.
 */
function pplMergeRows_(base, live, key) {
  if (!live || !live.length) return base;
  const idx = {};
  base.forEach(function (r, i) {
    const k = String(r[key] == null ? '' : r[key]);
    if (k) idx[k] = i;
  });
  const out = base.slice();
  live.forEach(function (r) {
    const k = String(r[key] == null ? '' : r[key]);
    if (!k) return;
    if (Object.prototype.hasOwnProperty.call(idx, k)) out[idx[k]] = r;
    else out.push(r);
  });
  return out;
}

/** Поля amoCRM, которые нужны живой дельте (те же id, что в etl_amo.gs). */
const PPL_AMO_PHONE_FIELD = 1648707;
const PPL_AMO_ALFA_FIELD = 1652617;
/** Поле сделки utm_campaign: сюда же pplTagDirectCourses пишет курс. */
const PPL_AMO_UTM_CAMPAIGN_FIELD = 1648719;
/** Поле сделки utm_content: сюда pplTagDirectCourses пишет ID объявления. */
const PPL_AMO_UTM_CONTENT_FIELD = 1648715;
/**
 * Поле сделки «Источник заявки» (список) и его вариант «Instagram»
 * (сверено по API 28.09.2026). У сделок из чата его ставит робот amoCRM,
 * а у заведённых вручную оно пустое, и такие сделки не попадали ни в
 * канал Instagram, ни в разрез по курсам. Перепривязка его дописывает.
 */
const PPL_AMO_SOURCE_FIELD = 1654275;
const PPL_AMO_SOURCE_INSTAGRAM = 4702307;
/** Строка разреза для заявок, у которых курс из переписки не определён. */
const PPL_NO_COURSE = '(курс не определён)';

/**
 * Живая дельта заявок: сделки amoCRM, изменённые сегодня. Листы снимаются
 * в 5 утра, а менеджеры проставляют «Источник заявки» и телефоны в течение
 * дня — без дельты страница до завтра показывала бы утреннюю картину.
 * Возвращает строки в формате RAW_leads.
 */
function pplLiveLeadRows_(pipelineNames) {
  const base = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4';
  const auth = { headers: { Authorization: 'Bearer ' + pplProp_('AMO_TOKEN') }, muteHttpExceptions: true };
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const from = Math.floor(midnight.getTime() / 1000);

  const leads = [];
  for (let page = 1; page <= 4; page++) {
    const resp = UrlFetchApp.fetch(base + '/leads?with=contacts&limit=250&page=' + page +
      '&filter[updated_at][from]=' + from, auth);
    if (resp.getResponseCode() !== 200) break;
    const chunk = ((JSON.parse(resp.getContentText())._embedded || {}).leads) || [];
    chunk.forEach(function (l) { leads.push(l); });
    if (chunk.length < 250) break;
  }
  if (!leads.length) return [];

  // телефоны и ссылку на Альфу добираем из контактов, как это делает etl_amo
  const contactIds = [];
  leads.forEach(function (l) {
    const cs = (l._embedded && l._embedded.contacts) || [];
    if (cs.length && contactIds.indexOf(cs[0].id) === -1) contactIds.push(cs[0].id);
  });
  const byContact = {};
  for (let i = 0; i < contactIds.length; i += 50) {
    const chunk = contactIds.slice(i, i + 50);
    const q = chunk.map(function (id) { return 'filter[id][]=' + id; }).join('&');
    const resp = UrlFetchApp.fetch(base + '/contacts?' + q + '&limit=50', auth);
    if (resp.getResponseCode() !== 200) continue;
    (((JSON.parse(resp.getContentText())._embedded) || {}).contacts || []).forEach(function (c) {
      let phone = '', alfa = '';
      (c.custom_fields_values || []).forEach(function (f) {
        const v = (f.values && f.values[0] && String(f.values[0].value || '')) || '';
        if (f.field_id === PPL_AMO_PHONE_FIELD) phone = v;
        if (f.field_id === PPL_AMO_ALFA_FIELD) alfa = v;
      });
      byContact[c.id] = { phone: pplNormPhone_(phone), alfa: alfa };
    });
  }

  return leads.map(function (l) {
    const cs = (l._embedded && l._embedded.contacts) || [];
    const cid = cs.length ? cs[0].id : '';
    const cd = byContact[cid] || {};
    return {
      created_at: new Date(l.created_at * 1000).toISOString(),
      phone_e164: cd.phone || '',
      source: pplLeadSource_(l),
      // без поля строка дельты затёрла бы курс из утреннего листа
      utm_campaign: pplLeadFieldValue_(l, PPL_AMO_UTM_CAMPAIGN_FIELD),
      pipeline: (pipelineNames && pipelineNames[l.pipeline_id]) || String(l.pipeline_id || ''),
      alfa_url: cd.alfa || '',
      lead_id: l.id,
      contact_id: cid
    };
  });
}

/** Первое значение пользовательского поля сделки amoCRM строкой. */
function pplLeadFieldValue_(lead, fieldId) {
  const f = ((lead && lead.custom_fields_values) || []).filter(function (x) {
    return x.field_id === fieldId;
  })[0];
  return (f && f.values && f.values[0] && String(f.values[0].value || '').trim()) || '';
}

/**
 * Живая дельта платежей: доходы Альфы за последние два дня. Фильтр
 * date_from у Альфы рабочий (в отличие от document_date_from), объём
 * крошечный. Формат строк — как в RAW_pays.
 */
function pplLivePayRows_() {
  const session = pplAlfaSession_();
  const d = new Date(Date.now() - 2 * 86400000);
  const dateFrom = ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
  const rows = [];
  pplAlfaBranches_().forEach(function (branch) {
    for (let page = 0; page < 4; page++) {
      const data = pplAlfaPage_(session, branch, 'pay', { page: page, pay_type_id: 1, date_from: dateFrom });
      const items = data.items || [];
      items.forEach(function (it) {
        if (it.pay_type_id !== 1) return;
        rows.push({
          document_date: it.document_date,
          customer_id: it.customer_id,
          income: Number(it.income || 0),
          branch: branch,
          pay_item_id: it.pay_item_id || '',
          payer_name: it.payer_name || '',
          pay_id: it.id
        });
      });
      if (items.length < 50) break;
    }
  });
  return rows;
}

/** Выручка по заявкам из Instagram — по фактическим оплатам в AlfaCRM. */
function pplRevenueFromAlfa_(since, until, spendByPlatform, amoCurrency, pipelineNames, direct) {
  const customers = pplRows_('RAW_alfa_customers');
  let leadRows = pplRows_('RAW_leads');
  let payRows = pplRows_('RAW_pays');
  // живая дельта — бонус к утренним листам; если amo или Альфа сейчас
  // недоступны, страница честно покажет утренний снимок, а не упадёт
  try { leadRows = pplMergeRows_(leadRows, pplLiveLeadRows_(pipelineNames), 'lead_id'); } catch (e) {}
  try { payRows = pplMergeRows_(payRows, pplLivePayRows_(), 'pay_id'); } catch (e) {}
  const core = pplAlfaRevenueCore_(leadRows, customers, payRows, since, until, direct);

  const spend = spendByPlatform.instagram;
  const adCur = spendByPlatform.currency;
  const rate = Number(PropertiesService.getScriptProperties().getProperty('FX_RATE') || 0);
  const same = adCur && amoCurrency && adCur === amoCurrency;
  const comparable = !spendByPlatform.mixed_currency && (same || rate > 0);
  const spendInAmo = same ? spend : (rate > 0 ? spend * rate : null);

  return {
    source: 'alfa',
    // страница по mode отличает «клиенты ещё не выгружались» от «связи нет»
    mode: customers.length ? 'phone' : 'no_customers',
    leads: core.leads,
    with_phone: core.with_phone,
    with_alfa: core.with_alfa,
    matched_share: core.matched_share,
    paid_customers: core.paid_customers,
    revenue: core.revenue,
    cac: comparable && core.paid_customers ? spendInAmo / core.paid_customers : null,
    roas: comparable && spendInAmo ? core.revenue / spendInAmo : null,
    brands: core.brands,
    by_source: core.by_source,
    by_pipeline: core.by_pipeline,
    by_course: core.by_course,
    paid_list: core.paid_list,
    // кто написал в Direct; адрес amoCRM — для ссылок на сделки
    direct: { amo: 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru', rows: core.direct }
  };
}

/**
 * Диагностика: где лежат телефоны у Instagram-заявок, оставшихся без
 * phone_e164. Владелец видит номера в карточках amo, а выгрузка их не
 * находит — значит, номер живёт не в том поле или не у того контакта,
 * куда смотрит etl_amo (поле 1648707 первого контакта сделки).
 *
 * Берёт 20 свежих таких заявок, тянет их сделки со ВСЕМИ контактами и
 * печатает в журнал каждое заполненное поле каждого контакта, помечая
 * телефоноподобные значения. Запуск руками из редактора, в листы не пишет.
 */
function pplDumpContactFields() {
  const auth = { headers: { Authorization: 'Bearer ' + pplProp_('AMO_TOKEN') }, muteHttpExceptions: true };
  const base = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4';

  const rows = pplRows_('RAW_leads').filter(function (l) {
    return /instagram/i.test(String(l.source || '')) && !String(l.phone_e164 || '').trim() && l.lead_id;
  }).slice(-20);
  Logger.log('Instagram-заявок без телефона в выборке: ' + rows.length);

  let noContacts = 0, contactsSeen = 0, phoneLikeSeen = 0;
  rows.forEach(function (l) {
    const resp = UrlFetchApp.fetch(base + '/leads/' + l.lead_id + '?with=contacts', auth);
    if (resp.getResponseCode() !== 200) { Logger.log(l.lead_id + ': сделка HTTP ' + resp.getResponseCode()); return; }
    const lead = JSON.parse(resp.getContentText());

    // телефон могли записать в поле самой сделки
    (lead.custom_fields_values || []).forEach(function (f) {
      const fv = (f.values && f.values[0] && String(f.values[0].value || '')) || '';
      if (fv.replace(/\D/g, '').length >= 9) {
        Logger.log('lead ' + l.lead_id + ' ПОЛЕ СДЕЛКИ ' + f.field_id + ' «' + f.field_name + '» ~ ' + fv.slice(0, 30));
      }
    });

    // ...или в примечание сделки
    const nr = UrlFetchApp.fetch(base + '/leads/' + l.lead_id + '/notes?limit=50', auth);
    if (nr.getResponseCode() === 200) {
      (((JSON.parse(nr.getContentText())._embedded || {}).notes) || []).forEach(function (n) {
        const txt = String((n.params && (n.params.text || n.params.message_text)) || '');
        const digits = txt.replace(/\D/g, '');
        if (digits.length >= 9 && digits.length <= 15) {
          Logger.log('lead ' + l.lead_id + ' ПРИМЕЧАНИЕ ' + (n.note_type || '') + ' ~ ' + txt.slice(0, 60));
        }
      });
    }

    const contacts = ((lead._embedded || {}).contacts || []);
    if (!contacts.length) { noContacts++; Logger.log('lead ' + l.lead_id + ': контактов нет'); return; }

    contacts.forEach(function (c, idx) {
      const cr = UrlFetchApp.fetch(base + '/contacts/' + c.id, auth);
      if (cr.getResponseCode() !== 200) return;
      contactsSeen++;
      const cd = JSON.parse(cr.getContentText());
      const fields = (cd.custom_fields_values || []).map(function (f) {
        const v = (f.values && f.values[0] && String(f.values[0].value || '')) || '';
        const digits = v.replace(/\D/g, '');
        const mark = digits.length >= 9 ? '  <-- ТЕЛЕФОНОПОДОБНОЕ' : '';
        if (mark) phoneLikeSeen++;
        return f.field_id + ' / ' + (f.field_code || '-') + ' «' + f.field_name + '» = ' + v.slice(0, 40) + mark;
      });
      Logger.log('lead ' + l.lead_id + ' контакт#' + idx + ' id=' + c.id + ' «' + (cd.name || '') + '»' +
        (fields.length ? '\n  ' + fields.join('\n  ') : ': заполненных полей нет'));
    });
  });
  Logger.log('Итого: без контактов ' + noContacts + ' из ' + rows.length +
    '; контактов просмотрено ' + contactsSeen + '; телефоноподобных значений ' + phoneLikeSeen);
}

/* ============ 3b. Общие хелперы Meta Ads ============ */

/**
 * GET к Graph API. Принимает и короткий путь («act_1/insights?...»), и
 * готовый адрес из paging.next — в нём токен уже вшит, второй раз его
 * добавлять нельзя. Возвращает разобранное тело или null, если Meta
 * ответила не 200: вызывающий сам решает, это «пусто» или «сбой».
 */
function pplGraph_(pathOrUrl) {
  const url = pathOrUrl.indexOf('http') === 0
    ? pathOrUrl
    : 'https://graph.facebook.com/' + FB_API_VERSION + '/' + pathOrUrl +
      (pathOrUrl.indexOf('?') === -1 ? '?' : '&') +
      'access_token=' + encodeURIComponent(pplProp_('FB_TOKEN'));
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return null;
  return JSON.parse(resp.getContentText());
}

/**
 * Пустая строка-накопитель метрик Insights. Глубины разговора (depth2,
 * depth3) здесь нет: она появляется в строке, только если Meta её
 * прислала, — иначе два нуля в каждой строке «Дней» зря съедали бы
 * место под потолком кэша в 100 КБ.
 */
function pplZeroMetrics_() {
  return {
    spend: 0, impressions: 0, clicks: 0, link_clicks: 0, messages: 0,
    // качество переписок: см. PPL_MSG_ACTIONS
    new_chats: 0, blocks: 0
  };
}

/**
 * Какие действия Meta в какую метрику накопителя.
 *
 * «Сообщений» — начатые переписки (messaging_conversation_started_7d:
 * человек написал после недели тишины или впервые). Из них «новых» —
 * messaging_first_reply, те, кто не писал бизнесу никогда: разница — это
 * вернувшиеся, часто действующие клиенты. Блокировки — messaging_block.
 *
 * Счётчиков глубины разговора (2 и 3+ сообщений от человека) в
 * документации Meta нет, хотя в ответах они встречаются. Берём, если
 * пришли; какие виды действий Meta прислала на самом деле, отчёт
 * отдаёт в msg_types, и страница показывает колонку только тогда.
 */
const PPL_MSG_ACTIONS = [
  ['messages', 'messaging_conversation_started'],
  ['new_chats', 'messaging_first_reply'],
  ['blocks', 'messaging_block'],
  ['depth2', 'messaging_user_depth_2_message_send'],
  ['depth3', 'messaging_user_depth_3_message_send']
];

/** Всё, что складывается: деньги, показы, клики и все переписочные метрики. */
const PPL_SUM_KEYS = ['spend', 'impressions', 'clicks', 'link_clicks']
  .concat(PPL_MSG_ACTIONS.map(function (m) { return m[0]; }));

/**
 * Приплюсовывает к накопителю одну строку Insights. Вынесено из четырёх
 * одинаковых мест: раньше «начатую переписку» опознавали в каждом своей
 * копией условия, и любая правка обязана была попасть во все.
 */
function pplAddMetrics_(row, r) {
  row.spend += Number(r.spend || 0);
  row.impressions += Number(r.impressions || 0);
  row.clicks += Number(r.clicks || 0);
  row.link_clicks += Number(r.inline_link_clicks || 0);
  (r.actions || []).forEach(function (a) {
    const type = String(a.action_type);
    PPL_MSG_ACTIONS.forEach(function (m) {
      if (type.indexOf(m[1]) !== -1) row[m[0]] = (row[m[0]] || 0) + Number(a.value || 0);
    });
  });
  return row;
}

/**
 * Сумма метрик по списку строк. Охват и частота в неё не входят: один
 * человек видит несколько объявлений, и сумма охватов его пересчитает.
 */
function pplSumMetrics_(rows) {
  const t = pplZeroMetrics_();
  rows.forEach(function (r) {
    PPL_SUM_KEYS.forEach(function (k) {
      if (r[k] !== undefined) t[k] = (t[k] || 0) + Number(r[k] || 0);
    });
  });
  return t;
}

/**
 * a − b по всем метрикам: неделя до последней = 14 дней минус 7. Так обе
 * недели считаются в часовом поясе кабинета, как в Ads Manager, а не в
 * нашем. Копеечные расхождения округления не должны давать минус.
 */
function pplMinusMetrics_(a, b) {
  const t = pplZeroMetrics_();
  PPL_SUM_KEYS.forEach(function (k) {
    if (a[k] === undefined && t[k] === undefined) return;
    t[k] = Math.max(0, Number(a[k] || 0) - Number(b[k] || 0));
  });
  t.spend = Math.round(t.spend * 100) / 100;
  return t;
}

/** Какие «переписочные» действия Meta прислала вообще — для сверки колонок. */
function pplMsgTypes_(rows) {
  const seen = {};
  rows.forEach(function (r) {
    (r.actions || []).forEach(function (a) {
      const t = String(a.action_type || '');
      if (t.indexOf('messaging') !== -1) seen[t] = true;
    });
  });
  return Object.keys(seen).sort();
}

/**
 * Несколько GET к Graph API разом: UrlFetchApp.fetchAll шлёт их
 * параллельно. Разрезы и сравнение недель — пачки независимых запросов,
 * и по очереди они складывались в лишние десять секунд ожидания.
 * На место каждого пути — разобранное тело или null, как у pplGraph_.
 */
function pplGraphAll_(paths) {
  if (!paths.length) return [];
  const token = encodeURIComponent(pplProp_('FB_TOKEN'));
  return UrlFetchApp.fetchAll(paths.map(function (p) {
    return {
      url: 'https://graph.facebook.com/' + FB_API_VERSION + '/' + p +
        (p.indexOf('?') === -1 ? '?' : '&') + 'access_token=' + token,
      muteHttpExceptions: true
    };
  })).map(function (resp) {
    return resp.getResponseCode() === 200 ? JSON.parse(resp.getContentText()) : null;
  });
}

/**
 * Все строки ответа Insights: первая страница уже на руках, остальные —
 * по paging.next. ok = false, если Meta не отдала хоть одну страницу.
 */
function pplGraphRows_(body, maxPages) {
  const out = { rows: [], ok: !!body };
  for (let page = 0; body && page < (maxPages || 5); page++) {
    (body.data || []).forEach(function (r) { out.rows.push(r); });
    const next = body.paging && body.paging.next;
    if (!next) break;
    body = pplGraph_(next);
    if (!body) out.ok = false;
  }
  return out;
}

/** Бюджет Meta приходит в копейках/центах строкой. */
function pplBudget_(v) {
  return Number(v || 0) / 100;
}

/** Что означает account_status рекламного кабинета. */
const PPL_ACCOUNT_STATUS = {
  1: 'работает', 2: 'отключён', 3: 'есть неоплаченная задолженность',
  7: 'на проверке', 8: 'ждёт списания', 9: 'отсрочка платежа',
  100: 'готовится к закрытию', 101: 'закрыт'
};

/** Почему кабинет отключили. */
const PPL_DISABLE_REASON = {
  1: 'нарушение рекламной политики', 2: 'проверка прав на контент',
  3: 'проблема с платежом', 4: 'кабинет закрыт', 5: 'проверка AFC',
  6: 'проверка бизнеса', 7: 'закрыт навсегда',
  8: 'кабинет не использовался', 9: 'кабинет не использовался'
};

/**
 * Состояние рекламных кабинетов.
 *
 * Без этого «Сейчас активно» врёт в самый неподходящий момент: когда не
 * проходит платёж, Meta останавливает показы на уровне кабинета, а у
 * объявлений остаётся статус ACTIVE и расписание в будущем. Страница
 * бодро писала бы «крутится 21 объявление», когда не крутится ничего.
 *
 * Лимит затрат останавливает показы не хуже отключённого кабинета,
 * поэтому считаем и его: spend_cap с amount_spent приходят в центах.
 *
 * Если Meta не ответила — считаем кабинет рабочим и помечаем unknown:
 * ложная тревога хуже молчания, из-за неё перестанут верить и настоящей.
 */
function pplAccountStatuses_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('acct_status');
  if (hit) return JSON.parse(hit);

  const out = {};
  pplAdAccounts_().forEach(function (acct) {
    const info = pplGraph_(acct + '?fields=' + encodeURIComponent(
      'name,currency,account_status,disable_reason,spend_cap,amount_spent'));
    if (!info) { out[acct] = { id: acct, name: acct, ok: true, unknown: true }; return; }
    const st = Number(info.account_status || 0);
    const cap = pplBudget_(info.spend_cap);
    const spent = pplBudget_(info.amount_spent);
    const reason = Number(info.disable_reason || 0);
    out[acct] = {
      id: acct,
      name: info.name || acct,
      currency: info.currency || '',
      status: st,
      // «работает» — только явный ACTIVE: всё остальное так или иначе
      // останавливает показы, и пусть страница скажет об этом прямо
      ok: st === 1,
      status_text: PPL_ACCOUNT_STATUS[st] || ('статус ' + st),
      reason: PPL_DISABLE_REASON[reason] || '',
      spend_cap: cap,
      amount_spent: spent,
      cap_reached: cap > 0 && spent >= cap
    };
  });
  try { cache.put('acct_status', JSON.stringify(out), 300); } catch (e) {}
  return out;
}

/** Кабинет доставляет рекламу? Остановленный не доставляет ничего. */
function pplAccountDelivers_(acc) {
  return !acc || (acc.ok && !acc.cap_reached);
}

/** Поля, по которым видно, доставляется объявление или уже нет. */
const PPL_DELIVERY_FIELDS =
  'id,effective_status,campaign{stop_time},adset{end_time}';

/**
 * Объявление действительно крутится?
 *
 * Одного effective_status мало, и это главная ловушка Meta. У кампании с
 * законченным расписанием Ads Manager пишет «Завершено», а объявление
 * внутри неё продолжает отдаваться как ACTIVE — статуса «завершено» на
 * уровне объявления в API просто нет. У поднятых из ленты публикаций
 * расписание конечное всегда, поэтому без проверки дат «активными»
 * оказывались все посты, поднятые за годы: 325 кампаний вместо десятка.
 *
 * Поэтому три условия: сам статус ACTIVE (фильтр запроса дублируем в
 * коде — если Meta его однажды проигнорирует, отчёт не должен молча
 * раздуться), расписание группы не закончилось и кампания не остановлена
 * по времени. Группа без end_time крутится бессрочно — её оставляем.
 */
function pplIsDelivering_(a, nowMs) {
  if (String(a.effective_status || '') !== 'ACTIVE') return false;
  const end = (a.adset || {}).end_time;
  if (end && new Date(end).getTime() < nowMs) return false;
  const stop = (a.campaign || {}).stop_time;
  if (stop && new Date(stop).getTime() < nowMs) return false;
  return true;
}

/** Все объявления кабинетов с полями доставки; пусто, если Meta не ответила. */
function pplFetchAdsForDelivery_(extraFields, limit) {
  const rows = [];
  pplAdAccounts_().forEach(function (acct) {
    let url = acct + '/ads?effective_status=' + encodeURIComponent('["ACTIVE"]') +
      // фигурные скобки в fields обязательно кодировать: UrlFetchApp
      // отвергает такой адрес с «Invalid argument», а не ошибкой Meta
      '&fields=' + encodeURIComponent(extraFields || PPL_DELIVERY_FIELDS) +
      '&limit=' + (limit || 500);
    for (let page = 0; page < 6 && url; page++) {
      const body = pplGraph_(url);
      if (!body) { rows.partial = true; break; }
      (body.data || []).forEach(function (r) { r.account = acct; rows.push(r); });
      url = body.paging && body.paging.next ? body.paging.next : null;
    }
  });
  return rows;
}

/**
 * Картинка креатива на каждое объявление: { ad_id: url }.
 *
 * Отдельным запросом от pplIgProfileMap_, хотя оба спрашивают creative:
 * размер миниатюры задаётся параметром поля (`.thumbnail_width(320)`), и
 * если Meta однажды перестанет этот синтаксис понимать, упасть должны
 * картинки, а не разбивка по профилям — на ней держатся все деньги.
 * Поэтому же есть запасной запрос без параметров: лучше мыльные 64×320,
 * чем пустые строки.
 *
 * Ссылки подписанные и живут не вечно, поэтому кэш 6 часов — как у
 * креативов: страница всё равно перезапрашивает JSON каждые 5–10 минут.
 */
function pplAdThumbs_(adIds) {
  const out = {};
  if (!adIds || !adIds.length) return out;

  const cache = CacheService.getScriptCache();
  const cached = cache.getAll(adIds.map(function (id) { return 'thumb_' + id; }));
  const missing = [];
  adIds.forEach(function (id) {
    const v = cached['thumb_' + id];
    if (v === undefined) missing.push(id);
    else if (v) out[id] = v;
  });

  for (let i = 0; i < missing.length; i += 25) {
    const chunk = missing.slice(i, i + 25);
    const ids = '?ids=' + encodeURIComponent(chunk.join(','));
    let body = pplGraph_(ids + '&fields=' + encodeURIComponent(
      'creative.thumbnail_width(320).thumbnail_height(320){thumbnail_url}'));
    if (!body) {
      body = pplGraph_(ids + '&fields=' + encodeURIComponent('creative{thumbnail_url}'));
    }
    if (!body) continue;
    const toCache = {};
    chunk.forEach(function (id) {
      const url = ((body[id] || {}).creative || {}).thumbnail_url || '';
      // пустоту тоже запоминаем, иначе объявления без картинки будем
      // спрашивать у Meta при каждой загрузке страницы
      toCache['thumb_' + id] = url;
      if (url) out[id] = url;
    });
    cache.putAll(toCache, 21600);
  }
  return out;
}

/** Идентификаторы объявлений, которые Meta прямо сейчас доставляет. */
function pplActiveAdIds_() {
  const out = {};
  const now = Date.now();
  const accounts = pplAccountStatuses_();
  pplFetchAdsForDelivery_().forEach(function (a) {
    // остановленный кабинет не доставляет ничего, кем бы объявление себя
    // ни считало — иначе зелёная точка на «Днях» горит у мёртвых строк
    if (!pplAccountDelivers_(accounts[a.account])) return;
    if (pplIsDelivering_(a, now)) out[a.id] = true;
  });
  return out;
}

/**
 * Диагностика к отчёту «Сейчас активно»: показывает, сколько объявлений
 * Meta считает ACTIVE и сколько из них на самом деле уже отработали своё.
 * Запускать из редактора, смотреть журнал выполнения.
 */
function pplDiagActive() {
  const now = Date.now();
  const rows = pplFetchAdsForDelivery_();
  let notActive = 0, finished = 0, live = 0;
  const examples = [];
  rows.forEach(function (a) {
    if (String(a.effective_status || '') !== 'ACTIVE') { notActive++; return; }
    if (pplIsDelivering_(a, now)) { live++; return; }
    finished++;
    if (examples.length < 5) {
      examples.push(a.id + ' | группа до ' + ((a.adset || {}).end_time || '—') +
        ' | кампания до ' + ((a.campaign || {}).stop_time || '—'));
    }
  });
  Logger.log('Meta отдала объявлений: ' + rows.length);
  Logger.log('  не ACTIVE (фильтр запроса не сработал): ' + notActive);
  Logger.log('  ACTIVE, но расписание кончилось: ' + finished);
  Logger.log('  реально крутится: ' + live);
  examples.forEach(function (e) { Logger.log('  пример завершённого: ' + e); });
}

/* ============ 3c. Дневной отчёт по таргету ============ */

/**
 * Дневная разбивка рекламы (view=daily): расход, показы, клики и начатые
 * переписки по каждому дню периода — как в ручных таблицах таргетолога,
 * только заполняется само из Meta Ads Insights.
 *
 * «Сообщений» — это action_type messaging_conversation_started_7d:
 * человек из рекламы начал переписку. Производные метрики (CPC, CPM,
 * CTR, цена сообщения) страница считает сама из сырых чисел.
 *
 * part=active отдаёт другой отчёт — «что крутится прямо сейчас», а
 * part=audience — разрезы по возрасту, месту показа и времени. Они
 * висят на том же view намеренно: маршрутизация видов живёт в Код.gs,
 * которого нет в репозитории, и каждый новый view — ещё один файл,
 * который надо править вслепую в онлайн-редакторе. Тут же деплоится
 * один people.gs.
 */
function pplBuildDaily(params) {
  params = params || {};
  if (params.part === 'active') return pplBuildActive(params);
  if (params.part === 'audience') return pplBuildAudience(params);
  const until = params.until || pplIsoDate_(new Date());
  const since = params.since || until.slice(0, 8) + '01';   // по умолчанию с начала месяца

  const cache = CacheService.getScriptCache();
  // Номер в ключе — версия формата ответа. Кэш общий для всех версий
  // развёртывания, и без номера новая версия ещё 10 минут отдавала бы
  // ответ старой, без новых полей: страница выглядит «ничего не поменялось».
  // Меняется формат — меняется и номер (так же у active_now2).
  const cacheKey = 'daily2_' + since + '_' + until;
  if (params.nocache !== '1') {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }

  const byDate = {};
  let currency = '', mixed = false;
  // если какой-то кабинет не ответил, отчёт отдаём, но в кэш не кладём —
  // иначе разовый сбой Meta на 10 минут прикидывается «данных нет»
  let partial = false;
  pplAdAccounts_().forEach(function (acct) {
    const url = 'https://graph.facebook.com/' + FB_API_VERSION + '/' + acct + '/insights' +
      '?level=account&time_increment=1' +
      '&fields=spend,impressions,clicks,inline_link_clicks,actions,account_currency' +
      '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) +
      '&limit=200&access_token=' + encodeURIComponent(pplProp_('FB_TOKEN'));
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) { partial = true; return; }
    ((JSON.parse(resp.getContentText()).data) || []).forEach(function (r) {
      const d = r.date_start;
      if (!byDate[d]) { byDate[d] = pplZeroMetrics_(); byDate[d].date = d; }
      pplAddMetrics_(byDate[d], r);
      const cur = String(r.account_currency || '');
      if (cur) {
        if (!currency) currency = cur;
        else if (currency !== cur) mixed = true;
      }
    });
  });

  // --- те же дни, но раздельно по Instagram-профилям ---
  // Дневная строка на каждое объявление (level=ad + time_increment=1),
  // профиль объявления — из креатива (pplIgProfileMap_, кэш надолго).
  const perAd = [];
  pplAdAccounts_().forEach(function (acct) {
    let url = 'https://graph.facebook.com/' + FB_API_VERSION + '/' + acct + '/insights' +
      '?level=ad&time_increment=1' +
      '&fields=ad_id,ad_name,adset_name,campaign_id,campaign_name,' +
      'spend,impressions,clicks,inline_link_clicks,actions' +
      '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) +
      '&limit=500&access_token=' + encodeURIComponent(pplProp_('FB_TOKEN'));
    // страниц может быть несколько: объявления × дни
    for (let page = 0; page < 6 && url; page++) {
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) { partial = true; break; }
      const body = JSON.parse(resp.getContentText());
      (body.data || []).forEach(function (r) { perAd.push(r); });
      url = body.paging && body.paging.next ? body.paging.next : null;
    }
  });

  const adIds = [];
  perAd.forEach(function (r) {
    if (adIds.indexOf(r.ad_id) === -1) adIds.push(r.ad_id);
  });
  const map = pplIgProfileMap_(adIds);

  // Охват и частота каждого объявления за весь период. Из дневных строк
  // их не сложить: один и тот же человек видит объявление много дней
  // подряд. Не пришли — отчёт не «частичный», просто колонка пустая:
  // иначе разовый сбой этого запроса лишал бы кэша весь отчёт.
  const reachByAd = {};
  let reachMissing = false;
  pplGraphAll_(pplAdAccounts_().map(function (acct) {
    return acct + '/insights?level=ad&fields=ad_id,reach,frequency' +
      '&time_range=' + encodeURIComponent(JSON.stringify({ since: since, until: until })) +
      '&limit=500';
  })).forEach(function (body) {
    const res = pplGraphRows_(body, 6);
    if (!res.ok) reachMissing = true;
    res.rows.forEach(function (r) {
      reachByAd[r.ad_id] = {
        reach: Number(r.reach || 0),
        frequency: Math.round(Number(r.frequency || 0) * 100) / 100
      };
    });
  });

  const byProfile = {};
  perAd.forEach(function (r) {
    const actor = map.actorByAd[r.ad_id] || '';
    const key = actor || '(профиль не определён)';
    if (!byProfile[key]) {
      byProfile[key] = { profile_id: actor, profile: map.names[actor] || key, byDate: {} };
    }
    const p = byProfile[key];
    const d = r.date_start;
    if (!p.byDate[d]) { p.byDate[d] = pplZeroMetrics_(); p.byDate[d].date = d; }
    pplAddMetrics_(p.byDate[d], r);
  });

  const profiles = Object.keys(byProfile).map(function (k) {
    const p = byProfile[k];
    return {
      profile_id: p.profile_id,
      profile: p.profile,
      days: Object.keys(p.byDate).sort().map(function (d) { return p.byDate[d]; })
    };
  }).sort(function (a, b) {
    const s = function (x) { return x.days.reduce(function (t, d) { return t + d.spend; }, 0); };
    return s(b) - s(a);
  });

  // --- те же деньги, но по конкретным объявлениям внутри кампаний ---
  // Считается из уже скачанного perAd: отдельного запроса к Meta не нужно,
  // дневные строки просто складываются по ad_id за весь период.
  const activeIds = pplActiveAdIds_();
  const byAd = {};
  perAd.forEach(function (r) {
    const id = r.ad_id;
    if (!byAd[id]) {
      const actor = map.actorByAd[id] || '';
      byAd[id] = pplZeroMetrics_();
      byAd[id].ad_id = id;
      byAd[id].ad_name = r.ad_name || id;
      byAd[id].adset_name = r.adset_name || '';
      byAd[id].campaign_id = r.campaign_id || '';
      byAd[id].campaign_name = r.campaign_name || '(кампания без названия)';
      byAd[id].profile_id = actor;
      byAd[id].profile = actor ? (map.names[actor] || actor) : '';
      byAd[id].active = !!activeIds[id];
      byAd[id].days = 0;
      byAd[id].first_date = r.date_start;
      byAd[id].last_date = r.date_start;
    }
    const a = byAd[id];
    pplAddMetrics_(a, r);
    // «дней в работе» считаем по дням с открученными деньгами: строка с
    // нулём приходит и на день, когда объявление стояло на паузе
    if (Number(r.spend || 0) > 0) a.days++;
    if (r.date_start < a.first_date) a.first_date = r.date_start;
    if (r.date_start > a.last_date) a.last_date = r.date_start;
  });

  const byCampaign = {};
  Object.keys(byAd).forEach(function (id) {
    const a = byAd[id];
    const key = a.campaign_id || a.campaign_name;
    if (!byCampaign[key]) {
      byCampaign[key] = {
        campaign_id: a.campaign_id, campaign_name: a.campaign_name, ads: []
      };
    }
    byCampaign[key].ads.push(a);
  });
  const thumbs = pplAdThumbs_(Object.keys(byAd));
  const campaigns = Object.keys(byCampaign).map(function (k) {
    const c = byCampaign[k];
    c.ads.sort(function (x, y) { return y.spend - x.spend; });
    c.ads.forEach(function (a) {
      a.thumb = thumbs[a.ad_id] || '';
      const rf = reachByAd[a.ad_id];
      if (rf) { a.reach = rf.reach; a.frequency = rf.frequency; }
      // название кампании уже есть у самой кампании, а profile_id странице
      // не нужен: на длинном периоде объявлений сотни, и лишние поля
      // пробивают 100 КБ — потолок значения в CacheService
      delete a.campaign_id; delete a.campaign_name; delete a.profile_id;
    });
    c.totals = pplSumMetrics_(c.ads);
    c.active_ads = c.ads.filter(function (a) { return a.active; }).length;
    return c;
  }).sort(function (a, b) { return b.totals.spend - a.totals.spend; });

  const days = Object.keys(byDate).sort().map(function (k) { return byDate[k]; });
  const out = {
    view: 'daily',
    since: since,
    until: until,
    updated: new Date().toISOString(),
    currency: currency,
    mixed_currency: mixed,
    days: days,
    by_profile: profiles,
    by_campaign: campaigns,
    msg_types: pplMsgTypes_(perAd),
    reach_missing: reachMissing,
    partial: partial
  };
  try {
    const json = JSON.stringify(out);
    if (!partial && json.length < 100000) cache.put(cacheKey, json, 600);
  } catch (e) {}
  return out;
}

/* ============ 3d. Что крутится прямо сейчас ============ */

/** Пороги выгорания креатива — см. pplBurnout_. */
const PPL_FREQ_TIRED = 3;        // частота за 7 дней, при которой подорожание — уже усталость
const PPL_FREQ_HIGH = 4.5;       // …а при этой тревожно и без подорожания
const PPL_COST_GROWTH = 0.3;     // сообщение подорожало на 30% и больше
const PPL_CTR_DROP = 0.3;        // кликают на 30% реже (для объявлений без переписок)
const PPL_BURN_MIN_IMPR = 1000;  // меньше показов за неделю — судить не по чему
const PPL_BURN_MIN_MSG = 3;      // сообщений неделей раньше, чтобы было с чем сравнить цену

/**
 * Выгорает ли объявление.
 *
 * Город небольшой: родители из аудитории быстро заканчиваются, одни и те
 * же люди видят рекламу по 4–5 раз за неделю, и переписка дорожает.
 * Сигнал — связка «частота высокая И стало хуже, чем неделей раньше»:
 * высокая частота при прежней цене — ещё не беда, а подорожание при
 * низкой частоте — скорее аукцион или сезон, креатив тут ни при чём.
 *
 * Для объявлений на переписку судим по цене сообщения; CTR — только
 * когда переписок нет и сравнивать цену не с чем: подешевевшее сообщение
 * при упавшем CTR — не выгорание.
 *
 * week — последние 7 полных дней (с frequency), prev — 7 дней до них.
 * Возвращает { level: 'hot' | 'warn' | '', reason }.
 */
function pplBurnout_(week, prev) {
  const none = { level: '', reason: '' };
  const freq = Number(week.frequency || 0);
  if (Number(week.impressions || 0) < PPL_BURN_MIN_IMPR || freq < PPL_FREQ_TIRED) return none;
  const f = 'частота ' + freq.toFixed(1).replace('.', ',');

  const prevCost = prev.messages >= PPL_BURN_MIN_MSG ? prev.spend / prev.messages : 0;
  if (prevCost) {
    if (!week.messages) {
      // сообщений не стало вовсе, а денег ушло как на два прежних
      if (week.spend >= 2 * prevCost) return { level: 'hot', reason: f + ', а сообщений за неделю ни одного' };
    } else {
      const growth = week.spend / week.messages / prevCost - 1;
      if (growth >= PPL_COST_GROWTH) {
        return { level: 'hot', reason: f + ', сообщение подорожало на ' + Math.round(growth * 100) + '%' };
      }
    }
  } else if (!week.messages && prev.impressions >= PPL_BURN_MIN_IMPR && prev.link_clicks) {
    const drop = 1 - (week.link_clicks / week.impressions) / (prev.link_clicks / prev.impressions);
    if (drop >= PPL_CTR_DROP) {
      return { level: 'hot', reason: f + ', кликают на ' + Math.round(drop * 100) + '% реже' };
    }
  }
  if (freq >= PPL_FREQ_HIGH) {
    return { level: 'warn', reason: f + ': одни и те же люди видят объявление почти каждый день' };
  }
  return none;
}

/**
 * Отчёт «Сейчас активно» (view=daily&part=active): дерево
 * кампания → группа → объявление из того, что Meta прямо сейчас
 * доставляет, с дневным бюджетом и цифрами за сегодня и за 7 дней.
 *
 * Активность берём у Meta, а не выводим из расхода: объявление могли
 * включить час назад и оно ещё ничего не потратило, а вчерашний лидер
 * может быть уже выключен. Фильтр effective_status=ACTIVE учитывает и
 * родителей — выключенная кампания забирает с собой все свои объявления.
 *
 * Кэш короткий (5 минут): страницу открывают именно чтобы увидеть, что
 * происходит сейчас, и получасовой кэш здесь врал бы по смыслу.
 */
function pplBuildActive(params) {
  params = params || {};
  const cache = CacheService.getScriptCache();
  if (params.nocache !== '1') {
    const hit = cache.get('active_now2');
    if (hit) return JSON.parse(hit);
  }

  let currency = '', mixed = false, partial = false;
  const campaigns = {};       // campaign_id → кампания с группами и объявлениями
  const adIds = [];
  const today = {}, week = {}, twoWeeks = {};   // ad_id → метрики
  const nowMs = Date.now();
  let finished = 0;           // отсеяно как «уже отработало»
  let blocked = 0;            // включено, но кабинет не доставляет
  const accounts = pplAccountStatuses_();

  pplAdAccounts_().forEach(function (acct) {
    const acc = accounts[acct] || {};
    if (acc.currency) {
      if (!currency) currency = acc.currency;
      else if (currency !== acc.currency) mixed = true;
    }
    const acctName = acc.name || acct;
    const delivers = pplAccountDelivers_(acc);

    // 1. что сейчас доставляется
    let url = acct + '/ads?effective_status=' + encodeURIComponent('["ACTIVE"]') +
      // фигурные скобки в fields обязательно кодировать: UrlFetchApp
      // отвергает такой адрес с «Invalid argument», а не ошибкой Meta
      '&fields=' + encodeURIComponent(
        'id,name,effective_status,created_time,' +
        'campaign{id,name,objective,daily_budget,lifetime_budget,stop_time},' +
        'adset{id,name,daily_budget,lifetime_budget,start_time,end_time}') +
      '&limit=200';
    for (let page = 0; page < 6 && url; page++) {
      const body = pplGraph_(url);
      if (!body) { partial = true; break; }
      (body.data || []).forEach(function (a) {
        // отработавшее своё объявление Meta продолжает звать ACTIVE —
        // см. pplIsDelivering_, без этой отсечки отчёт врёт в сотни раз
        if (!pplIsDelivering_(a, nowMs)) { finished++; return; }
        if (!delivers) blocked++;
        const camp = a.campaign || {};
        const set = a.adset || {};
        const cid = camp.id || '(без кампании)';
        if (!campaigns[cid]) {
          campaigns[cid] = {
            campaign_id: camp.id || '',
            campaign_name: camp.name || '(кампания без названия)',
            objective: camp.objective || '',
            account: acctName,
            account_ok: delivers,
            daily_budget: pplBudget_(camp.daily_budget),
            lifetime_budget: pplBudget_(camp.lifetime_budget),
            adsets: {}
          };
        }
        const sid = set.id || '(без группы)';
        if (!campaigns[cid].adsets[sid]) {
          campaigns[cid].adsets[sid] = {
            adset_id: set.id || '',
            adset_name: set.name || '(группа без названия)',
            daily_budget: pplBudget_(set.daily_budget),
            lifetime_budget: pplBudget_(set.lifetime_budget),
            start_time: set.start_time || '',
            end_time: set.end_time || '',
            ads: []
          };
        }
        campaigns[cid].adsets[sid].ads.push({
          ad_id: a.id, ad_name: a.name || a.id, created_time: a.created_time || ''
        });
        if (adIds.indexOf(a.id) === -1) adIds.push(a.id);
      });
      url = body.paging && body.paging.next ? body.paging.next : null;
    }

    // 2. цифры: сегодня, 7 и 14 дней — три запроса разом. 14 дней нужны
    // только ради недели до последней (см. pplMinusMetrics_), а охват с
    // частотой — ради выгорания (pplBurnout_)
    const presets = [
      ['today', today, ''],
      ['last_7d', week, ',reach,frequency'],
      ['last_14d', twoWeeks, '']
    ];
    pplGraphAll_(presets.map(function (p) {
      return acct + '/insights?level=ad&date_preset=' + p[0] +
        '&fields=ad_id,spend,impressions,clicks,inline_link_clicks,actions' + p[2] + '&limit=500';
    })).forEach(function (body, i) {
      const bucket = presets[i][1];
      const res = pplGraphRows_(body, 5);
      if (!res.ok) partial = true;
      res.rows.forEach(function (r) {
        if (!bucket[r.ad_id]) bucket[r.ad_id] = pplZeroMetrics_();
        pplAddMetrics_(bucket[r.ad_id], r);
        if (r.frequency !== undefined) {
          bucket[r.ad_id].reach = Number(r.reach || 0);
          bucket[r.ad_id].frequency = Math.round(Number(r.frequency || 0) * 100) / 100;
        }
      });
    });
  });

  const map = pplIgProfileMap_(adIds);
  const thumbs = pplAdThumbs_(adIds);

  const out_campaigns = Object.keys(campaigns).map(function (cid) {
    const c = campaigns[cid];
    const adsets = Object.keys(c.adsets).map(function (sid) {
      const s = c.adsets[sid];
      s.ads = s.ads.map(function (a) {
        const actor = map.actorByAd[a.ad_id] || '';
        a.profile_id = actor;
        a.profile = actor ? (map.names[actor] || actor) : '';
        a.thumb = thumbs[a.ad_id] || '';
        a.today = today[a.ad_id] || pplZeroMetrics_();
        a.week = week[a.ad_id] || pplZeroMetrics_();
        a.prev = pplMinusMetrics_(twoWeeks[a.ad_id] || pplZeroMetrics_(), a.week);
        a.burnout = pplBurnout_(a.week, a.prev);
        return a;
      }).sort(function (x, y) { return y.week.spend - x.week.spend; });
      s.today = pplSumMetrics_(s.ads.map(function (a) { return a.today; }));
      s.week = pplSumMetrics_(s.ads.map(function (a) { return a.week; }));
      s.prev = pplSumMetrics_(s.ads.map(function (a) { return a.prev; }));
      return s;
    }).sort(function (x, y) { return y.week.spend - x.week.spend; });

    // при CBO бюджет задан на кампании, а у групп нули — тогда берём его
    const setsBudget = adsets.reduce(function (t, s) { return t + s.daily_budget; }, 0);
    return {
      campaign_id: c.campaign_id, campaign_name: c.campaign_name,
      objective: c.objective, account: c.account, account_ok: c.account_ok,
      daily_budget: c.daily_budget || setsBudget,
      budget_on_campaign: c.daily_budget > 0,
      lifetime_budget: c.lifetime_budget,
      adsets: adsets,
      ads_count: adsets.reduce(function (t, s) { return t + s.ads.length; }, 0),
      today: pplSumMetrics_(adsets.map(function (s) { return s.today; })),
      week: pplSumMetrics_(adsets.map(function (s) { return s.week; })),
      prev: pplSumMetrics_(adsets.map(function (s) { return s.prev; }))
    };
  }).sort(function (a, b) { return b.week.spend - a.week.spend; });

  // выгорание считаем только у того, что кабинет реально показывает
  const burnt = { hot: 0, warn: 0 };
  out_campaigns.forEach(function (c) {
    if (!c.account_ok) return;
    c.adsets.forEach(function (s) {
      s.ads.forEach(function (a) { if (burnt[a.burnout.level] !== undefined) burnt[a.burnout.level]++; });
    });
  });

  const out = {
    view: 'active',
    updated: new Date().toISOString(),
    currency: currency,
    mixed_currency: mixed,
    campaigns: out_campaigns,
    finished: finished,
    accounts: Object.keys(accounts).map(function (k) { return accounts[k]; }),
    totals: {
      campaigns: out_campaigns.length,
      adsets: out_campaigns.reduce(function (t, c) { return t + c.adsets.length; }, 0),
      // «крутится» — только то, что кабинет реально доставляет; остальное
      // считаем отдельно, иначе большая цифра на карточке будет враньём
      ads: out_campaigns.reduce(function (t, c) {
        return t + (c.account_ok ? c.ads_count : 0);
      }, 0),
      ads_blocked: blocked,
      daily_budget: out_campaigns.reduce(function (t, c) { return t + c.daily_budget; }, 0),
      today: pplSumMetrics_(out_campaigns.map(function (c) { return c.today; })),
      week: pplSumMetrics_(out_campaigns.map(function (c) { return c.week; })),
      prev: pplSumMetrics_(out_campaigns.map(function (c) { return c.prev; })),
      burnout_hot: burnt.hot,
      burnout_warn: burnt.warn
    },
    partial: partial
  };

  try {
    const json = JSON.stringify(out);
    if (!partial && json.length < 100000) cache.put('active_now2', json, 300);
  } catch (e) {}
  return out;
}

/* ============ 3e. Кому и где: разрезы аудитории ============ */

/** Часы на странице — по Минску: UTC+3 круглый год, без перевода часов. */
const PPL_LOCAL_UTC_OFFSET = 3;

/**
 * Разрезы рекламы за период (view=daily&part=audience): возраст и пол,
 * площадка и место показа, час дня и день недели — где переписка
 * обходится дешевле и куда деньги уходят впустую.
 *
 * По Instagram-профилям: в «Детали» пишут одни люди, в CODDY, «Прознание»
 * и «Уикенд» — другие, и общая таблица по кабинету их смешивала. Поэтому
 * разрезы запрашиваются по каждому объявлению (level=ad) и раскладываются
 * по профилю из креатива — тем же pplIgProfileMap_, что делит «Дни».
 * «Все вместе» — сумма тех же строк, а не отдельный запрос: иначе итог
 * профилей и общий расходились бы на спрятанные Meta мелкие ячейки.
 * Восемь запросов (4 разреза × 2 кабинета) уходят разом через fetchAll.
 *
 * Почасовую разбивку с 6 августа 2026 года Meta отдаёт не всем кабинетам:
 * где её не включили в Ads Manager, приходит пустой ответ с кодом 200.
 * Поэтому пустые часы — это флаг hours_missing, а сбой именно этого
 * запроса не делает отчёт частичным: иначе тот не попадал бы в кэш никогда.
 */
function pplBuildAudience(params) {
  params = params || {};
  const until = params.until || pplIsoDate_(new Date());
  const since = params.since || pplIsoDate_(pplDaysAgo_(29));

  const cache = CacheService.getScriptCache();
  // номер в ключе — версия формата ответа, см. pplBuildDaily
  const cacheKey = 'aud2_' + since + '_' + until;
  if (params.nocache !== '1') {
    const hit = cache.get(cacheKey);
    if (hit) return JSON.parse(hit);
  }

  const CUTS = [
    'breakdowns=age,gender',
    'breakdowns=publisher_platform,platform_position',
    'breakdowns=hourly_stats_aggregated_by_advertiser_time_zone',
    'time_increment=1'
  ];
  const HOUR = 2;
  const accts = pplAdAccounts_();
  const tz = pplAccountTz_();
  const range = encodeURIComponent(JSON.stringify({ since: since, until: until }));
  const paths = [];
  accts.forEach(function (acct) {
    CUTS.forEach(function (cut) {
      paths.push(acct + '/insights?level=ad&' + cut +
        '&fields=ad_id,spend,impressions,clicks,inline_link_clicks,actions,account_currency' +
        '&time_range=' + range + '&limit=500');
    });
  });

  const rowsByCut = CUTS.map(function () { return []; });
  let currency = '', mixed = false, partial = false, hoursFailed = false;
  pplGraphAll_(paths).forEach(function (body, i) {
    const cut = i % CUTS.length;
    // строк по объявлениям много: объявления × возрасты, × часы, × дни
    const res = pplGraphRows_(body, 12);
    if (!res.ok) {
      if (cut === HOUR) hoursFailed = true;
      else partial = true;
    }
    res.rows.forEach(function (r) {
      r.account = accts[Math.floor(i / CUTS.length)];
      const cur = String(r.account_currency || '');
      if (cur) {
        if (!currency) currency = cur;
        else if (currency !== cur) mixed = true;
      }
      rowsByCut[cut].push(r);
    });
  });

  const adIds = {};
  rowsByCut.forEach(function (rows) { rows.forEach(function (r) { adIds[r.ad_id] = true; }); });
  const map = pplIgProfileMap_(Object.keys(adIds));
  const offsets = {};
  accts.forEach(function (a) { offsets[a] = (tz[a] || {}).offset; });
  const groups = pplAudienceGroups_(rowsByCut, map.actorByAd, offsets);

  const all = groups['*'];
  const profiles = Object.keys(groups).filter(function (k) { return k !== '*'; }).map(function (k) {
    const g = groups[k];
    g.profile = g.profile_id ? (map.names[g.profile_id] || g.profile_id) : '(профиль не определён)';
    return g;
  }).sort(function (a, b) { return b.totals.spend - a.totals.spend; });

  const out = {
    view: 'audience',
    since: since,
    until: until,
    updated: new Date().toISOString(),
    currency: currency,
    mixed_currency: mixed,
    // «все вместе» — на верхнем уровне, как и раньше; по профилям — в profiles
    totals: all.totals,
    age_gender: all.age_gender,
    placements: all.placements,
    hours: all.hours,
    hours_missing: !all.hours.length && !hoursFailed && all.totals.spend > 0,
    hours_failed: hoursFailed,
    weekdays: all.weekdays,
    profiles: profiles,
    tz: accts.map(function (a) { return tz[a] || null; }),
    msg_types: pplMsgTypes_(rowsByCut[3]),
    partial: partial
  };
  try {
    const json = JSON.stringify(out);
    if (!partial && json.length < 100000) cache.put(cacheKey, json, 600);
  } catch (e) {}
  return out;
}

/**
 * Строки разрезов по объявлениям → группы: '*' — все вместе, дальше по
 * профилю объявления ('?' — профиль не определён). rowsByCut — строки
 * [возраст×пол, место показа, часы, дни] с полями ad_id и account;
 * actorByAd — профиль каждого объявления; offsets — пояс кабинета.
 *
 * Итог группы — по дневным строкам: у разрезов Meta прячет мелкие ячейки
 * (например, возраст «неизвестен»), и их суммы чуть меньше настоящих.
 * Пустые часы и дни — нулями: на графике дыра должна быть видна как ноль.
 */
function pplAudienceGroups_(rowsByCut, actorByAd, offsets) {
  const raw = {};
  const groupOf = function (key, actor) {
    if (!raw[key]) {
      raw[key] = { profile_id: actor, age: {}, place: {}, hours: {}, days: {}, totals: pplZeroMetrics_(), hourRows: 0 };
    }
    return raw[key];
  };
  groupOf('*', '');
  const targets = function (r) {
    const actor = actorByAd[r.ad_id] || '';
    return [raw['*'], groupOf(actor || '?', actor)];
  };

  (rowsByCut[0] || []).forEach(function (r) {
    targets(r).forEach(function (g) {
      pplBucket_(g.age, r.age + '|' + r.gender, { age: r.age || '', gender: r.gender || '' }, r);
    });
  });
  (rowsByCut[1] || []).forEach(function (r) {
    targets(r).forEach(function (g) {
      pplBucket_(g.place, r.publisher_platform + '|' + r.platform_position,
        { platform: r.publisher_platform || '', position: r.platform_position || '' }, r);
    });
  });
  (rowsByCut[2] || []).forEach(function (r) {
    const h = pplLocalHour_(r.hourly_stats_aggregated_by_advertiser_time_zone, offsets[r.account]);
    if (h === null) return;
    targets(r).forEach(function (g) { g.hourRows++; pplBucket_(g.hours, h, { hour: h }, r); });
  });
  (rowsByCut[3] || []).forEach(function (r) {
    const dow = pplWeekday_(r.date_start);
    targets(r).forEach(function (g) {
      pplAddMetrics_(g.totals, r);
      pplBucket_(g.days, dow, { dow: dow }, r);
    });
  });

  const values = function (m) { return Object.keys(m).map(function (k) { return pplRoundSpend_(m[k]); }); };
  const filled = function (m, keys, field) {
    return keys.map(function (k) {
      if (m[k]) return pplRoundSpend_(m[k]);
      const z = pplZeroMetrics_();
      z[field] = k;
      return z;
    });
  };
  const HOURS = [];
  for (let h = 0; h < 24; h++) HOURS.push(h);

  const out = {};
  Object.keys(raw).forEach(function (k) {
    const g = raw[k];
    out[k] = {
      profile_id: g.profile_id,
      totals: pplRoundSpend_(g.totals),
      age_gender: values(g.age).sort(pplAgeGenderOrder_),
      placements: values(g.place).sort(function (a, b) { return b.spend - a.spend; }),
      hours: g.hourRows ? filled(g.hours, HOURS, 'hour') : [],
      weekdays: filled(g.days, [1, 2, 3, 4, 5, 6, 7], 'dow')
    };
  });
  return out;
}

/**
 * Расход до центов: сумма float-ов даёт 12.340000000000002, и такие
 * хвосты в сотнях строк разрезов зря съедали место под потолком кэша.
 */
function pplRoundSpend_(row) {
  row.spend = Math.round(Number(row.spend || 0) * 100) / 100;
  return row;
}

/** Накопитель разреза: строка на ключ, метрики складываются. */
function pplBucket_(map, key, base, r) {
  if (!map[key]) {
    map[key] = pplZeroMetrics_();
    Object.keys(base).forEach(function (k) { map[key][k] = base[k]; });
  }
  pplAddMetrics_(map[key], r);
}

/** Возраст по порядку («18-24» раньше «25-34», неизвестный в конце), внутри — женщины, мужчины. */
function pplAgeGenderOrder_(a, b) {
  const age = function (s) { const n = parseInt(s, 10); return isFinite(n) ? n : 999; };
  const sex = function (g) { return g === 'female' ? 0 : g === 'male' ? 1 : 2; };
  return age(a.age) - age(b.age) || sex(a.gender) - sex(b.gender);
}

/**
 * Час показа из разбивки Meta («14:00:00 - 14:59:59» в часовом поясе
 * кабинета) → час по Минску. Смещение кабинета неизвестно — час как есть.
 */
function pplLocalHour_(slot, offset) {
  const h = parseInt(String(slot || '').slice(0, 2), 10);
  if (!isFinite(h)) return null;
  const shift = typeof offset === 'number' && isFinite(offset) ? PPL_LOCAL_UTC_OFFSET - offset : 0;
  return ((Math.floor(h + shift) % 24) + 24) % 24;
}

/** День недели даты «YYYY-MM-DD»: 1 — понедельник … 7 — воскресенье. */
function pplWeekday_(iso) {
  const d = new Date(String(iso) + 'T00:00:00Z').getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * Часовой пояс каждого кабинета: { act_…: { name, offset } | null }.
 * Отдельным запросом, а не в pplAccountStatuses_: если Meta однажды не
 * поймёт эти поля, сломаться должны часы на «Аудитории», а не красная
 * плашка остановленного кабинета. Пояс меняют редко — кэш 6 часов.
 */
function pplAccountTz_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('acct_tz');
  if (hit) return JSON.parse(hit);
  const accts = pplAdAccounts_();
  const out = {};
  let complete = true;
  pplGraphAll_(accts.map(function (a) { return a + '?fields=timezone_name,timezone_offset_hours_utc'; }))
    .forEach(function (body, i) {
      const offset = body ? Number(body.timezone_offset_hours_utc) : NaN;
      out[accts[i]] = body && isFinite(offset) ? { name: body.timezone_name || '', offset: offset } : null;
      if (!out[accts[i]]) complete = false;
    });
  if (complete) {
    try { cache.put('acct_tz', JSON.stringify(out), 21600); } catch (e) {}
  }
  return out;
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
function pplAggregateByAd_(people, spendByAd, direct, toAmo) {
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

  // пока кликов Meta нет (App Review), колонки заполняют люди из Direct
  // (pplDirectAdStats_); клики, когда появятся, точнее — они и победят
  const stats = (direct && direct.byAd) || {};
  const courseOf = (direct && direct.courseOf) || {};
  const conv = toAmo || pplSameCurrency_;
  return Object.keys(acc).map(function (adId) {
    const a = acc[adId];
    const d = !a.wrote && stats[adId] ? stats[adId] : null;
    const m = d || a;
    const s = spendByAd[adId] || { ad_name: '', campaign_name: '', spend: 0, clicks: 0, impressions: 0 };
    // выручка — в валюте Альфы, расход — в валюте Meta: CAC и ROAS считаем
    // после перевода, иначе делили бы рубли на доллары
    const spendAmo = s.spend ? conv(s.spend) : null;
    return {
      ad_id: adId,
      ad_name: s.ad_name,
      campaign_name: s.campaign_name,
      spend: s.spend,
      clicks: s.clicks,
      wrote: m.wrote,
      deals: m.deals,
      won: m.won,
      revenue: m.revenue,
      course: courseOf[adId] || '',
      attr: d ? d.attr : (a.wrote ? 'meta' : ''),
      cac: spendAmo !== null && m.won ? spendAmo / m.won : null,
      roas: spendAmo ? m.revenue / spendAmo : null
    };
  }).sort(function (x, y) { return y.spend - x.spend; });
}

/* ============ 4b. Курс из первого сообщения в Direct → метка в amoCRM ============ */

/*
 * Лист «Курсы из Direct» заполняет webhook.gs по вебхуку SendPulse: кто
 * написал (ник и имя в Instagram), когда и какой курс назван в первом
 * сообщении, а если переписка пришла из рекламы — ещё и ID объявления.
 * С 27.09.2026 там строка на каждого, кто написал, и с курсом, и без.
 * Здесь находим сделку этого человека в amoCRM и кладём курс в поле
 * utm_campaign (плюс тег «курс: …»), а ID объявления — в utm_content; для
 * строки без курса только запоминаем, новая ли это переписка (no_course).
 * Дальше это едет в дашборд обычной выгрузкой RAW_leads и живой дельтой —
 * отдельного пути не нужно.
 *
 * Почему не сразу в вебхуке: сделку amoCRM создаёт своя интеграция с
 * Instagram, и к моменту вебхука SendPulse её может ещё не быть. Поэтому
 * строки ждут в листе, а задача раз в 10 минут пробует снова; через
 * PPL_DIRECT_MAX_TRIES попыток строка закрывается с причиной.
 *
 * Чужую работу не трогаем: если utm_campaign у сделки уже заполнен,
 * значение остаётся, добавляется только тег. В старую сделку клиента, куда
 * amoCRM подшил новую переписку, поля не пишем вовсе — только тег.
 */
const PPL_DIRECT_SHEET = 'Курсы из Direct';
const PPL_DIRECT_MAX_TRIES = 12;          // 12 × 10 минут = 2 часа
const PPL_DIRECT_BATCH = 60;              // строк за запуск — укладываемся в лимит времени
const PPL_DIRECT_BEFORE_MS = 30 * 60000;  // сделка могла появиться чуть раньше вебхука
const PPL_DIRECT_AFTER_MS = 3 * 3600000;  // …или заметно позже
const PPL_DIRECT_EVENT_BEFORE_S = 30;     // событие amoCRM обычно на 2–6 с раньше SendPulse
const PPL_DIRECT_EVENT_AFTER_S = 90;      // …или позже, если amoCRM задержался с чатом

/**
 * Ставит курс из Direct в сделки amoCRM. Запускается триггером раз в
 * 10 минут (pplSetupDirectCourseTrigger); можно и руками из редактора.
 */
function pplTagDirectCourses() {
  // статус пишется по номеру строки, а досыпка истории (pplBackfillSort_)
  // сортирует лист — под одним замком они не пересекутся
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    pplTagDirectRows_();
    // сбой перепривязки не должен ронять разметку: упавший триггер
    // Google шлёт владелице письмом каждые 10 минут
    try { pplRelinkOldLeads_(); } catch (e) { Logger.log('Перепривязка Direct: ' + e); }
  } finally {
    lock.releaseLock();
  }
}

function pplTagDirectRows_() {
  const sh = SpreadsheetApp.openById(pplProp_('SHEET_ID')).getSheetByName(PPL_DIRECT_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  const values = sh.getDataRange().getValues();
  const head = values[0].map(String);
  const col = {};
  head.forEach(function (h, i) { col[h] = i; });

  const base = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4';
  const token = pplProp_('AMO_TOKEN');
  let done = 0;
  for (let i = 1; i < values.length && done < PPL_DIRECT_BATCH; i++) {
    const r = values[i];
    const status = String(r[col.status] || '');
    if (status && status !== 'retry') continue;
    done++;
    const tries = Number(r[col.tries] || 0) + 1;
    const msg = {
      ts: pplAnyIso_(r[col.ts]) ? new Date(r[col.ts]).toISOString() : '',
      service: String(r[col.service] || ''),
      username: String(r[col.username] || ''),
      name: String(r[col.name] || ''),
      course: String(r[col.course] || ''),
      ad_id: col.ad_id === undefined ? '' : String(r[col.ad_id] || '')
    };
    let res;
    try {
      res = pplTagOneDirect_(msg, base, token);
    } catch (e) {
      res = { status: 'retry', note: String(e).slice(0, 200) };
    }
    let st = res.status;
    // не нашли — возможно, сделка ещё не создана; пробуем, пока есть попытки
    if (st === 'no_contact' || st === 'no_lead' || st === 'retry') {
      st = tries < PPL_DIRECT_MAX_TRIES ? 'retry' : st;
    }
    sh.getRange(i + 1, col.status + 1, 1, 3).setValues([[st, res.lead_id || '', tries]]);
    if (res.note) Logger.log('Курсы из Direct, строка ' + (i + 1) + ': ' + res.note);
  }
}

/** Одна строка: найти сделку и поставить метку. */
function pplTagOneDirect_(msg, base, token) {
  if (msg.service && msg.service !== 'instagram') return { status: 'skip_service' };
  // сделку ищем и без курса: таблица «Кто написал в Direct» показывает
  // новые переписки, а новая она или старая, видно только по сделке
  if (!msg.ts) return { status: 'skip_empty' };
  const auth = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };

  // 1. Сделка, куда amoCRM подшил само сообщение (событие «входящее
  // сообщение» в секундах от вебхука)
  const t = Math.floor(new Date(msg.ts).getTime() / 1000);
  const evResp = UrlFetchApp.fetch(base + '/events?limit=100&filter[type]=incoming_chat_message' +
    '&filter[created_at][from]=' + (t - PPL_DIRECT_EVENT_BEFORE_S) +
    '&filter[created_at][to]=' + (t + PPL_DIRECT_EVENT_AFTER_S), auth);
  const evCode = evResp.getResponseCode();
  if (evCode !== 200 && evCode !== 204) throw new Error('amo events HTTP ' + evCode);
  const events = evCode === 204 ? [] : (((JSON.parse(evResp.getContentText())._embedded) || {}).events || []);
  const evLeadId = pplPickChatEventLead_(msg.ts, events);
  let lead = evLeadId ? pplFetchLeads_(base, auth, [evLeadId])[0] || null : null;

  // 2. Нет события — ищем по имени: amoCRM называет контакт из Instagram
  // его ником или именем профиля
  if (!lead) {
    const contacts = [];
    const seen = {};
    [msg.username, msg.name].forEach(function (q) {
      q = String(q || '').replace(/^@/, '').trim();
      if (!q) return;
      const resp = UrlFetchApp.fetch(base + '/contacts?with=leads&limit=10&query=' + encodeURIComponent(q), auth);
      if (resp.getResponseCode() === 204) return;
      if (resp.getResponseCode() !== 200) throw new Error('amo contacts HTTP ' + resp.getResponseCode());
      (((JSON.parse(resp.getContentText())._embedded) || {}).contacts || []).forEach(function (c) {
        if (!seen[c.id]) { seen[c.id] = true; contacts.push(c); }
      });
    });

    const mine = pplDirectContacts_(msg, contacts);
    if (!mine.length) return { status: 'no_contact' };
    const leadIds = [];
    mine.forEach(function (c) {
      (((c._embedded || {}).leads) || []).forEach(function (l) {
        if (leadIds.indexOf(l.id) === -1) leadIds.push(l.id);
      });
    });
    if (!leadIds.length) return { status: 'no_lead' };
    lead = pplPickDirectLead_(msg.ts, pplFetchLeads_(base, auth, leadIds));
    if (!lead) return { status: 'no_lead' };
  }

  const plan = pplDirectPatch_(msg, lead);
  if (!plan.patch) return { status: plan.status, lead_id: lead.id };
  const resp = UrlFetchApp.fetch(base + '/leads', {
    method: 'patch',
    contentType: 'application/json',
    payload: JSON.stringify([plan.patch]),
    headers: auth.headers,
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    return { status: 'retry', lead_id: lead.id, note: 'PATCH HTTP ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 150) };
  }
  return { status: plan.status, lead_id: lead.id };
}

/** Сделки amoCRM по id, пачками по 50; withArg — что приложить (with=…). */
function pplFetchLeads_(base, auth, ids, withArg) {
  const leads = [];
  for (let i = 0; i < ids.length; i += 50) {
    const q = ids.slice(i, i + 50).map(function (id) { return 'filter[id][]=' + id; }).join('&');
    const resp = UrlFetchApp.fetch(base + '/leads?limit=50&' + (withArg ? 'with=' + withArg + '&' : '') + q, auth);
    if (resp.getResponseCode() === 204) continue;
    if (resp.getResponseCode() !== 200) throw new Error('amo leads HTTP ' + resp.getResponseCode());
    (((JSON.parse(resp.getContentText())._embedded) || {}).leads || []).forEach(function (l) { leads.push(l); });
  }
  return leads;
}

/**
 * Сделка по событию «входящее сообщение» amoCRM. Сообщение из Instagram
 * amoCRM подшивает туда, где уже идёт переписка человека, — нередко в
 * старую сделку действующего клиента, чей контакт менеджер переименовал
 * («vaskovskaya_oksana» → «Васковская Оксана»), и по имени её не найти.
 * Событие приходит на 2–6 секунд раньше вебхука SendPulse (26.09.2026),
 * поэтому берём ближайшее к ts − 3 с. Если двое написали почти одновременно
 * (разница меньше 5 с), не угадываем. Чистая функция: id сделки или 0.
 */
function pplPickChatEventLead_(tsIso, events) {
  const t = new Date(tsIso).getTime() / 1000;
  if (!t) return 0;
  const cands = (events || []).filter(function (e) {
    const m = (((e.value_after || [])[0]) || {}).message || {};
    const d = Number(e.created_at) - t;
    return e.entity_type === 'lead' && String(m.origin || '').indexOf('instagram') !== -1 &&
      d >= -PPL_DIRECT_EVENT_BEFORE_S && d <= PPL_DIRECT_EVENT_AFTER_S;
  }).map(function (e) {
    return { lead: Number(e.entity_id), gap: Math.abs(Number(e.created_at) - (t - 3)) };
  }).sort(function (a, b) { return a.gap - b.gap; });
  if (!cands.length) return 0;
  const rival = cands.filter(function (c) { return c.lead !== cands[0].lead; })[0];
  if (rival && rival.gap - cands[0].gap < 5) return 0;
  return cands[0].lead;
}

/**
 * Что писать в сделку. Курс → utm_campaign, объявление → utm_content —
 * только в сделку, заведённую на эту переписку (создана в окне
 * BEFORE/AFTER): в старой сделке клиента поле описывает прошлую заявку, и
 * курс приписал бы ей чужую выручку. Заполненное не трогаем. Тег «курс: …»
 * ставится в любую найденную сделку — менеджеру видно, о чём спросили.
 * asNew — сделку менеджер завёл на эту переписку позже, вручную
 * (перепривязка, pplRelinkOldLeads_): она новая, хоть и вне окна, и если
 * источник заявки в ней не поставлен — ставим Instagram: обращение пришло
 * из Direct. Поставленный менеджером («Звонок») не трогаем.
 * Чистая функция: { patch: объект для PATCH или null, status }.
 */
function pplDirectPatch_(msg, lead, asNew) {
  const t = new Date(msg.ts).getTime();
  const created = Number(lead.created_at || 0) * 1000;
  const fresh = !!asNew || (created >= t - PPL_DIRECT_BEFORE_MS && created <= t + PPL_DIRECT_AFTER_MS);
  const fields = [];
  if (asNew && !pplLeadFieldValue_(lead, PPL_AMO_SOURCE_FIELD)) {
    fields.push({ field_id: PPL_AMO_SOURCE_FIELD, values: [{ enum_id: PPL_AMO_SOURCE_INSTAGRAM }] });
  }
  // без курса и рекламы писать больше нечего — запоминаем только, новая ли переписка
  if (!msg.course && !msg.ad_id) {
    return {
      patch: fields.length ? { id: lead.id, custom_fields_values: fields } : null,
      status: fresh ? 'no_course' : 'old_lead'
    };
  }
  if (fresh && msg.course && !pplLeadFieldValue_(lead, PPL_AMO_UTM_CAMPAIGN_FIELD)) {
    fields.push({ field_id: PPL_AMO_UTM_CAMPAIGN_FIELD, values: [{ value: msg.course }] });
  }
  if (fresh && msg.ad_id && !pplLeadFieldValue_(lead, PPL_AMO_UTM_CONTENT_FIELD)) {
    fields.push({ field_id: PPL_AMO_UTM_CONTENT_FIELD, values: [{ value: msg.ad_id }] });
  }
  const status = !fresh ? 'old_lead' : fields.length ? 'ok' : 'has_value';
  const patch = { id: lead.id };
  if (fields.length) patch.custom_fields_values = fields;
  // tags_to_add — на верхнем уровне сделки: добавляет, не затирая чужие теги
  if (msg.course) patch.tags_to_add = [{ name: 'курс: ' + msg.course }];
  return { patch: fields.length || patch.tags_to_add ? patch : null, status: status };
}

/**
 * Контакты amoCRM, которые действительно этот человек: имя контакта
 * совпадает с ником или именем в Instagram. Регистр, «@», эмодзи и порядок
 * слов не важны: amoCRM называет контакт «Фамилия Имя», и профиль «Jane Mp»
 * становится контактом «Mp Jane». Поиск amoCRM ищет и по подстроке, и по
 * телефонам — брать первого попавшегося нельзя. Чистая функция.
 */
function pplDirectContacts_(msg, contacts) {
  const want = [pplNameKey_(msg.username), pplNameKey_(msg.name)].filter(Boolean);
  return (contacts || []).filter(function (c) { return want.indexOf(pplNameKey_(c.name)) !== -1; });
}

/** Имя как набор слов: без регистра, знаков и эмодзи, слова по алфавиту. */
function pplNameKey_(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Какая сделка — та самая. Лучше всего сделка, созданная около момента
 * сообщения (окно BEFORE/AFTER): её amoCRM и открыла на эту переписку.
 * Если такой нет, человек мог написать в уже открытую сделку — тогда
 * берём открытую, которую тронули не раньше чем за 15 минут до сообщения.
 * Закрытые старые сделки не трогаем. Чистая функция.
 */
function pplPickDirectLead_(tsIso, leads) {
  const t = new Date(tsIso).getTime();
  if (!t) return null;
  let best = null, bestGap = Infinity;
  (leads || []).forEach(function (l) {
    const created = Number(l.created_at || 0) * 1000;
    if (created < t - PPL_DIRECT_BEFORE_MS || created > t + PPL_DIRECT_AFTER_MS) return;
    const gap = Math.abs(created - t);
    if (gap < bestGap) { best = l; bestGap = gap; }
  });
  if (best) return best;
  let open = null;
  (leads || []).forEach(function (l) {
    if (l.status_id === AMO_WON || l.status_id === AMO_LOST) return;
    const updated = Number(l.updated_at || 0) * 1000;
    if (updated < t - 15 * 60000) return;
    if (!open || updated > Number(open.updated_at || 0) * 1000) open = l;
  });
  return open;
}

/**
 * Ставит триггер pplTagDirectCourses раз в 10 минут. Повторный запуск
 * безопасен: прежний триггер этой функции сносится. Ежедневные триггеры
 * (pplSetupDailyTriggers) не трогает.
 */
function pplSetupDirectCourseTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pplTagDirectCourses') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('pplTagDirectCourses').timeBased().everyMinutes(10).create();
}

/*
 * Перепривязка (с 28.09.2026). Бывает, что amoCRM подшивает новую
 * переписку в старую сделку клиента — даже закрытую (строка old_lead), и
 * менеджер заводит на обращение новую сделку руками. 27.09 так вопрос про
 * математику лёг в летнюю проигранную сделку «Интенсивов», а утром
 * менеджер завёл «Регулярные занятия». Без перепривязки строка навсегда
 * показывала бы летний «Отказ», а оплаты новой сделки не засчитывались
 * бы этому обращению. Поэтому раз в час смотрим контакты свежих old_lead:
 * появилась у того же контакта сделка после сообщения — строка
 * переключается на неё (status relinked), а в сделку ложатся курс и тег,
 * как в свежую. Правило amoCRM «новая сделка, если у клиента нет
 * активных» (сменили 28.09) большую часть таких случаев закрывает само;
 * это — для сделок, заведённых вручную.
 */

/** Сколько дней после сообщения ждём сделку, заведённую вручную. */
const PPL_RELINK_DAYS = 14;
/** Не чаще раза в час: проход обходит контакты всех свежих old_lead. */
const PPL_RELINK_EVERY_MS = 55 * 60000;
const PPL_RELINK_KEY = 'DIRECT_RELINK_AT';

function pplRelinkOldLeads_() {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const last = Number(props.getProperty(PPL_RELINK_KEY) || 0);
  if (now - last < PPL_RELINK_EVERY_MS) return;

  const sh = SpreadsheetApp.openById(pplProp_('SHEET_ID')).getSheetByName(PPL_DIRECT_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  const values = sh.getDataRange().getValues();
  const col = {};
  values[0].map(String).forEach(function (h, i) { col[h] = i; });

  // Первый проход — по всем old_lead: досыпка истории принесла их с начала
  // сентября, и часть уже дождалась своей новой сделки. Дальше — только по
  // тем, чьё окно ещё не закрылось (плюс сутки на последнюю проверку).
  const horizon = last ? now - (PPL_RELINK_DAYS + 1) * 86400000 : 0;
  const rows = [];
  const used = {};
  const relinked = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const st = String(r[col.status] || '');
    const leadId = Number(r[col.lead_id] || 0);
    // сделки, у которых уже есть своя строка, чужой строке не отдаём
    if (leadId && st !== 'old_lead') used[leadId] = true;
    const t = new Date(r[col.ts]).getTime();
    if (!leadId || !t || t < horizon) continue;
    // перепривязанные раньше — только проверить источник (см. ниже)
    if (st === 'relinked') { relinked.push(leadId); continue; }
    if (st !== 'old_lead') continue;
    rows.push({
      i: i, leadId: leadId,
      msg: {
        ts: new Date(t).toISOString(),
        course: String(r[col.course] || ''),
        ad_id: col.ad_id === undefined ? '' : String(r[col.ad_id] || '')
      }
    });
  }
  if (!rows.length && !relinked.length) { props.setProperty(PPL_RELINK_KEY, String(now)); return; }

  const base = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4';
  const auth = { headers: { Authorization: 'Bearer ' + pplProp_('AMO_TOKEN') }, muteHttpExceptions: true };
  const patchLead = function (patch) {
    return UrlFetchApp.fetch(base + '/leads', {
      method: 'patch',
      contentType: 'application/json',
      payload: JSON.stringify([patch]),
      headers: auth.headers,
      muteHttpExceptions: true
    }).getResponseCode() === 200;
  };

  // Источник у сделок, перепривязанных раньше: до 28.09 его не ставили, а
  // менеджер, заводя сделку руками, оставляет пустым. Пустой — Instagram.
  if (relinked.length) {
    pplFetchLeads_(base, auth, relinked).forEach(function (l) {
      if (pplLeadFieldValue_(l, PPL_AMO_SOURCE_FIELD)) return;
      const ok = patchLead({ id: l.id, custom_fields_values: [
        { field_id: PPL_AMO_SOURCE_FIELD, values: [{ enum_id: PPL_AMO_SOURCE_INSTAGRAM }] }] });
      Logger.log('Перепривязка Direct: источник Instagram в сделку ' + l.id + (ok ? '' : ' — не записался'));
    });
  }
  if (!rows.length) { props.setProperty(PPL_RELINK_KEY, String(now)); return; }
  const uniq = function (list) {
    const seen = {};
    return list.filter(function (x) { return !seen[x] && (seen[x] = true); });
  };

  // три пачки запросов на всё: контакты старых сделок → их сделки → сами сделки
  const contactsByLead = {};
  pplFetchLeads_(base, auth, uniq(rows.map(function (r) { return r.leadId; })), 'contacts')
    .forEach(function (l) {
      contactsByLead[l.id] = (((l._embedded || {}).contacts) || []).map(function (c) { return c.id; });
    });
  const contactIds = [];
  Object.keys(contactsByLead).forEach(function (k) { contactsByLead[k].forEach(function (c) { contactIds.push(c); }); });
  const leadsByContact = pplFetchContactLeadIds_(base, auth, uniq(contactIds));
  const leadIds = [];
  Object.keys(leadsByContact).forEach(function (k) { leadsByContact[k].forEach(function (id) { leadIds.push(id); }); });
  const leadById = {};
  pplFetchLeads_(base, auth, uniq(leadIds)).forEach(function (l) { leadById[l.id] = l; });

  pplRelinkPlan_(rows, contactsByLead, leadsByContact, leadById, used).forEach(function (p) {
    const plan = pplDirectPatch_(p.msg, p.lead, true);
    // не записалось — строку не трогаем, через час попробуем снова
    if (plan.patch && !patchLead(plan.patch)) {
      Logger.log('Перепривязка Direct, строка ' + (p.i + 1) + ': PATCH не прошёл');
      return;
    }
    sh.getRange(p.i + 1, col.status + 1, 1, 2).setValues([['relinked', p.lead.id]]);
    Logger.log('Перепривязка Direct, строка ' + (p.i + 1) + ': сделка ' + p.from + ' → ' + p.lead.id);
  });
  props.setProperty(PPL_RELINK_KEY, String(now));
}

/** Сделки контактов: { id контакта: [id сделок] }, пачками по 50. */
function pplFetchContactLeadIds_(base, auth, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const q = ids.slice(i, i + 50).map(function (id) { return 'filter[id][]=' + id; }).join('&');
    const resp = UrlFetchApp.fetch(base + '/contacts?limit=50&with=leads&' + q, auth);
    if (resp.getResponseCode() === 204) continue;
    if (resp.getResponseCode() !== 200) throw new Error('amo contacts HTTP ' + resp.getResponseCode());
    (((JSON.parse(resp.getContentText())._embedded) || {}).contacts || []).forEach(function (c) {
      out[c.id] = (((c._embedded || {}).leads) || []).map(function (l) { return l.id; });
    });
  }
  return out;
}

/**
 * Какие строки на какие сделки перепривязать. rows — строки old_lead
 * ({ i, leadId, msg }); contactsByLead — контакты старой сделки строки;
 * leadsByContact — id сделок контакта; leadById — сами сделки; used —
 * сделки, у которых уже есть своя строка. Идём от свежих сообщений к
 * старым: менеджер заводит сделку на последнее обращение, а не на то,
 * что было неделю назад. Одна сделка — одной строке. Чистая функция:
 * [{ i, lead, msg, from }].
 */
function pplRelinkPlan_(rows, contactsByLead, leadsByContact, leadById, used) {
  const taken = {};
  Object.keys(used || {}).forEach(function (k) { taken[k] = true; });
  return rows.slice().sort(function (a, b) {
    return String(b.msg.ts).localeCompare(String(a.msg.ts));
  }).map(function (row) {
    const cands = [];
    (contactsByLead[row.leadId] || []).forEach(function (cid) {
      (leadsByContact[cid] || []).forEach(function (id) {
        if (leadById[id] && !taken[id]) cands.push(leadById[id]);
      });
    });
    const lead = pplPickRelinkLead_(row.msg.ts, row.leadId, cands);
    if (!lead) return null;
    taken[lead.id] = true;
    return { i: row.i, lead: lead, msg: row.msg, from: row.leadId };
  }).filter(Boolean);
}

/**
 * Сделка, заведённая на переписку вручную: у того же контакта, создана
 * после сообщения (с запасом BEFORE — менеджер мог завести, пока человек
 * дописывал) и не позже PPL_RELINK_DAYS. Самая ранняя такая и есть ответ
 * на обращение. Чистая функция: сделка или null.
 */
function pplPickRelinkLead_(tsIso, oldLeadId, leads) {
  const t = new Date(tsIso).getTime();
  if (!t) return null;
  let best = null;
  (leads || []).forEach(function (l) {
    if (Number(l.id) === Number(oldLeadId)) return;
    const created = Number(l.created_at || 0) * 1000;
    if (created < t - PPL_DIRECT_BEFORE_MS || created > t + PPL_RELINK_DAYS * 86400000) return;
    if (!best || created < Number(best.created_at) * 1000) best = l;
  });
  return best;
}

/*
 * Кто написал в Direct — таблица страницы «Путь клиента»: по строке на
 * человека из листа «Курсы из Direct» — когда, в какой аккаунт, что написал
 * и чем кончилось в amoCRM (этап, причина отказа). Альфу и деньги добавляет
 * ядро выручки (pplAlfaRevenueCore_) по тем же правилам, что разрез по курсам.
 */

/** Сколько символов первого сообщения отдаём странице: текст кнопки влезает. */
const PPL_DIRECT_TEXT_MAX = 90;
/** Сколько последних людей отдаём странице: ответ должен влезать в кэш (100 КБ). */
const PPL_DIRECT_ROWS_MAX = 300;

/**
 * Таблица на странице — последние max человек: после досыпки истории их
 * сотни, и ответ перестал бы кэшироваться. Цифры по объявлениям и курсам
 * считаются до обрезки, по всем. Чистая функция.
 */
function pplDirectCap_(dir, max) {
  const rows = ((dir && dir.rows) || []).slice().sort(function (a, b) {
    return String(b.ts).localeCompare(String(a.ts));
  });
  return { amo: (dir && dir.amo) || '', total: rows.length, rows: rows.slice(0, max) };
}

/**
 * Строки листа за период (по дате сообщения) вместе с состоянием сделок.
 * Сделки берём из amoCRM живьём, а не из RAW_leads: там нет причины
 * отказа, а этап у сделок, тронутых сегодня, утренний.
 */
function pplDirectRows_(since, until) {
  const rows = pplDirectPick_(pplRows_(PPL_DIRECT_SHEET).filter(function (r) {
    const st = String(r.status || '');
    if (st === 'skip_service' || st === 'skip_empty') return false;
    const t = new Date(r.ts);
    if (isNaN(t.getTime())) return false;
    const d = pplAnyIso_(t);
    return d >= since && d <= until;
  }));
  if (!rows.length) return [];

  const base = 'https://' + pplProp_('AMO_SUBDOMAIN') + '.amocrm.ru/api/v4';
  const auth = { headers: { Authorization: 'Bearer ' + pplProp_('AMO_TOKEN') }, muteHttpExceptions: true };
  const ids = [];
  rows.forEach(function (r) {
    const id = Number(r.lead_id);
    if (id && ids.indexOf(id) === -1) ids.push(id);
  });
  const leadById = {};
  let stages = {};
  if (ids.length) {
    pplFetchLeads_(base, auth, ids, 'loss_reason').forEach(function (l) { leadById[l.id] = l; });
    stages = pplFetchPipelineStages_(base, auth);
  }
  return rows.map(function (r) { return pplDirectRow_(r, leadById[Number(r.lead_id)] || null, stages); });
}

/**
 * Какие строки листа показывать. С курсом — всегда. Без курса — только
 * новую переписку (задача нашла сделку, заведённую на неё: статус
 * no_course, или менеджер завёл её позже: relinked) и только если у того
 * же человека за период нет строки с курсом, иначе он попал бы в таблицу
 * дважды. Текущие разговоры старых контактов без курса — не обращения:
 * их не показываем и за их сделками в amoCRM не ходим. Чистая функция.
 */
function pplDirectPick_(rows) {
  const withCourse = {};
  rows.forEach(function (r) { if (String(r.course || '')) withCourse[String(r.contact_id)] = true; });
  return rows.filter(function (r) {
    if (String(r.course || '')) return true;
    const st = String(r.status || '');
    return (st === 'no_course' || st === 'relinked') && !withCourse[String(r.contact_id)];
  });
}

/**
 * Строка таблицы: сообщение + чем кончилась сделка. Чистая функция.
 * lead — сделка из API amoCRM (with=loss_reason) или null; stages —
 * { id воронки: { name, statuses: { id: название этапа } } }. client —
 * переписка ушла в старую сделку действующего клиента (та же проверка, что
 * в pplDirectPatch_): его оплаты рекламе не приписываем.
 */
function pplDirectRow_(r, lead, stages) {
  const ts = new Date(r.ts);
  const st = String(r.status || '');
  const out = {
    ts: ts.toISOString(),
    account: pplShortBot_(r.bot),
    name: String(r.name || r.username || '').normalize('NFC').trim(),
    course: String(r.course || ''),
    text: String(r.text || '').normalize('NFC').slice(0, PPL_DIRECT_TEXT_MAX),
    ad_id: String(r.ad_id || ''),
    lead_id: lead ? lead.id : '',
    pipeline: '', stage: '', reason: '', client: false,
    // сделки нет: пока статус пустой или retry, задача её ещё ищет
    outcome: !st || st === 'retry' ? 'wait' : 'no_lead'
  };
  if (!lead) return out;
  const pl = (stages || {})[lead.pipeline_id] || { name: '', statuses: {} };
  const created = Number(lead.created_at || 0) * 1000;
  out.pipeline = pl.name || '';
  out.stage = pl.statuses[lead.status_id] || '';
  out.outcome = lead.status_id === AMO_WON ? 'won' : lead.status_id === AMO_LOST ? 'lost' : 'open';
  out.reason = (((((lead._embedded || {}).loss_reason) || [])[0]) || {}).name || '';
  // сделку, заведённую позже вручную (перепривязка), считаем новой заявкой:
  // создана она не в окне сообщения, но заведена именно на это обращение
  out.relinked = st === 'relinked';
  out.client = !out.relinked &&
    !(created >= ts.getTime() - PPL_DIRECT_BEFORE_MS && created <= ts.getTime() + PPL_DIRECT_AFTER_MS);
  return out;
}

/**
 * Короткое имя Instagram-аккаунта — без эмодзи и слоганов. Чистая функция.
 * SendPulse отдаёт имя аккаунта «ДЕТСКИЙ КЛУБ…» в разложенном виде («и» +
 * знак краткой вместо «й», 26.09.2026), поэтому сначала собираем буквы.
 */
function pplShortBot_(name) {
  const s = String(name || '').normalize('NFC');
  if (/coddy/i.test(s)) return 'CODDY';
  if (/детал/i.test(s)) return 'Детали';
  if (/детск/i.test(s)) return 'Детский клуб';
  if (/прознан|каникул|уикенд|weekend/i.test(s)) return 'Прознание';
  return s.replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim().slice(0, 24);
}

/*
 * Люди из Direct по объявлениям и расход по курсам — для таблицы «По
 * объявлениям» и разреза «Курс из первого сообщения». Курс объявления
 * определяем тем же словарём, что и курс сообщения. Словарь — КОПИЯ
 * SP_COURSES / SP_COMBOS из webhook.gs: это другой проект Apps Script,
 * общего кода нет. Тест сверяет копии; новый курс — в оба файла.
 */
const PPL_COURSES = [
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

const PPL_COMBOS = [
  [['Roblox', '3D Blender'], 'Roblox + 3D Blender'],
  [['3D Blender', 'Unity'], '3D Blender + Unity']
];

/** Курс по тексту — точь-в-точь spCourse_ из webhook.gs. Чистая функция. */
function pplCourseOf_(text) {
  const s = String(text || '');
  if (!s) return '';
  const found = [];
  PPL_COURSES.forEach(function (c, order) {
    const m = c[1].exec(s);
    if (m) found.push({ name: c[0], at: m.index, order: order });
  });
  if (!found.length) return '';
  const names = found.map(function (f) { return f.name; });
  for (let i = 0; i < PPL_COMBOS.length; i++) {
    const parts = PPL_COMBOS[i][0];
    if (parts.every(function (p) { return names.indexOf(p) !== -1; })) return PPL_COMBOS[i][1];
  }
  found.sort(function (a, b) { return a.at - b.at || a.order - b.order; });
  return found[0].name;
}

/**
 * Кто из Direct пришёл с какого объявления. Точно — по ID объявления, если
 * SendPulse его передал (referral). Раз передал хоть однажды за период,
 * строки без ID — не из рекламы, и по курсу их не раскладываем. Иначе — по
 * курсу: курс объявления берём из названия кампании (там тема: «природная
 * глина сообщение»), не нашёлся — из названия объявления; курс человека —
 * из первого сообщения. Одно объявление на курс — цифры его; несколько —
 * у каждого общая цифра курса (attr 'shared'), в итог она входит один раз.
 * Сделка — только новая (не «уже был в amoCRM»), деньги — как в ядре.
 * Чистая функция: rows — revenue.direct.rows, spendByAd — pplFetchAdSpend_.
 */
function pplDirectAdStats_(rows, spendByAd) {
  const ads = spendByAd || {};
  const courseOf = {};
  const adsOf = {};
  Object.keys(ads).forEach(function (id) {
    const c = pplCourseOf_(ads[id].campaign_name) || pplCourseOf_(ads[id].ad_name);
    courseOf[id] = c;
    if (c) (adsOf[c] = adsOf[c] || []).push(id);
  });
  const list = rows || [];
  const exact = list.some(function (r) { return r.ad_id && ads[r.ad_id]; });
  const blank = function (attr) { return { wrote: 0, deals: 0, won: 0, revenue: 0, attr: attr }; };
  const add = function (a, r) {
    a.wrote++;
    if (r.lead_id && !r.client) a.deals++;
    if (r.revenue > 0) { a.won++; a.revenue += r.revenue; }
  };
  const byAd = {};
  const groups = {};
  const total = blank('');
  list.forEach(function (r) {
    let target = null;
    if (exact) {
      if (r.ad_id && ads[r.ad_id]) target = byAd[r.ad_id] || (byAd[r.ad_id] = blank('ad'));
    } else {
      const ids = r.course ? (adsOf[r.course] || []) : [];
      if (ids.length === 1) target = byAd[ids[0]] || (byAd[ids[0]] = blank('course'));
      else if (ids.length > 1) target = groups[r.course] || (groups[r.course] = blank('shared'));
    }
    if (!target) return;
    add(target, r);
    add(total, r);
  });
  Object.keys(groups).forEach(function (c) {
    adsOf[c].forEach(function (id) { byAd[id] = Object.assign({}, groups[c]); });
  });
  return { byAd: byAd, courseOf: courseOf, total: total, mode: exact ? 'ad' : 'course' };
}

/**
 * Расход по курсам к разрезу by_course: курс объявления — как в
 * pplDirectAdStats_. Курсы, на которые тратили, а заявок нет, добавляются
 * строками — слитый бюджет должен быть виден; расход объявлений без курса
 * ложится в «курс не определён». CAC и ROAS — в валюте Альфы через toAmo
 * (нечем перевести — null). Чистая функция.
 */
function pplCourseSpend_(byCourse, spendByAd, courseOf, toAmo) {
  const spend = {};
  Object.keys(spendByAd || {}).forEach(function (id) {
    const c = (courseOf || {})[id] || PPL_NO_COURSE;
    spend[c] = (spend[c] || 0) + Number(spendByAd[id].spend || 0);
  });
  const conv = toAmo || pplSameCurrency_;
  const rows = (byCourse || []).map(function (c) { return Object.assign({}, c); });
  Object.keys(spend).forEach(function (c) {
    if (!rows.some(function (r) { return r.course === c; })) {
      rows.push({ course: c, leads: 0, with_alfa: 0, paid: 0, revenue: 0 });
    }
  });
  return rows.map(function (r) {
    const s = spend[r.course] || 0;
    const amo = s ? conv(s) : null;
    r.spend = s;
    r.cac = amo !== null && r.paid ? amo / r.paid : null;
    r.roas = amo ? r.revenue / amo : null;
    return r;
  });
}

/**
 * Итог таблицы объявлений. Люди из Direct — по одному разу, даже если
 * «общая цифра курса» стоит у нескольких объявлений; клики Meta (после App
 * Review) точны по объявлению, их просто складываем. Чистая функция.
 */
function pplAdsTotal_(ads, stats, toAmo) {
  const t = { spend: 0, clicks: 0, wrote: 0, deals: 0, won: 0, revenue: 0 };
  const meta = ads.some(function (a) { return a.attr === 'meta'; });
  ads.forEach(function (a) {
    t.spend += a.spend;
    t.clicks += a.clicks;
    if (meta) { t.wrote += a.wrote; t.deals += a.deals; t.won += a.won; t.revenue += a.revenue; }
  });
  if (!meta && stats && stats.total) {
    t.wrote = stats.total.wrote; t.deals = stats.total.deals;
    t.won = stats.total.won; t.revenue = stats.total.revenue;
  }
  const amo = t.spend ? (toAmo || pplSameCurrency_)(t.spend) : null;
  t.cac = amo !== null && t.won ? amo / t.won : null;
  t.roas = amo ? t.revenue / amo : null;
  return t;
}

/** Перевод по умолчанию: валюта одна — как считала сводка до переводов. */
function pplSameCurrency_(x) { return x; }

/**
 * Перевод расхода Meta в валюту Альфы — та же логика, что в
 * pplRevenueFromAlfa_: одна валюта или курс из свойства FX_RATE. Нечем
 * сравнить — функция отдаёт null, и CAC с ROAS не считаются, а не врут.
 */
function pplToAmo_(spendByPlatform, amoCurrency) {
  const adCur = spendByPlatform.currency;
  const rate = Number(PropertiesService.getScriptProperties().getProperty('FX_RATE') || 0);
  const same = adCur && amoCurrency && adCur === amoCurrency;
  if (spendByPlatform.mixed_currency || !(same || rate > 0)) return function () { return null; };
  return function (x) { return same ? x : x * rate; };
}

/** Воронки amoCRM с этапами: { id: { name, statuses: { id: название } } }. */
function pplFetchPipelineStages_(base, auth) {
  const resp = UrlFetchApp.fetch(base + '/leads/pipelines', auth);
  if (resp.getResponseCode() !== 200) return {};
  const out = {};
  (((JSON.parse(resp.getContentText())._embedded) || {}).pipelines || []).forEach(function (p) {
    const st = {};
    (((p._embedded || {}).statuses) || []).forEach(function (s) { st[s.id] = s.name; });
    out[p.id] = { name: p.name, statuses: st };
  });
  return out;
}

/* ============ 4d. Досыпка Direct из истории SendPulse ============ */

/*
 * Приёмник SendPulse пишет людей с 26.09.2026 (с 27.09 — все новые
 * переписки, до того — только назвавших курс), а путь клиента хочется
 * видеть с начала сентября. История лежит в SendPulse: официальный API
 * отдаёт чаты бота и сообщения переписки. Ключ — свойство SP_API_KEY
 * (SendPulse → настройки → «Доступ к API» → «Ключи API»; «Учётные данные»
 * не перевыпускать — это ломает другие интеграции).
 *
 * pplBackfillDirect один раз проходит по четырём Instagram-ботам и
 * дописывает в «Курсы из Direct» строки, какие записал бы приёмник: одна
 * на человека за 7 дней, строка с курсом — отдельно, уже записанное не
 * дублируется. Разбирает их, как обычно, pplTagDirectCourses. Работает
 * порциями: у запуска 6 минут, продолжение ставит сама.
 */
const PPL_SP_API = 'https://api.sendpulse.com/instagram';
/** Instagram-боты SendPulse и подпись аккаунта для колонки bot. */
const PPL_SP_BOTS = [
  ['64e4355ab7138e627609350c', 'CODDY'],
  ['64e661577d31afbfb300e889', 'Детский клуб'],
  ['67a08b2f91bc4d9e45035fc8', 'Прознание (каникулы)'],
  ['69da155b4228b00c1c03d2a1', 'Детали']
];
const PPL_BACKFILL_SINCE = '2026-09-01T00:00:00+03:00';
/** С этой минуты всех новых пишет приёмник (IG webhook, версия 3). */
const PPL_BACKFILL_UNTIL = '2026-09-27T09:43:00Z';
const PPL_BACKFILL_KEY = 'DIRECT_BACKFILL';
const PPL_BACKFILL_RAW = 'SendPulse: история, образцы';
const PPL_BACKFILL_BUDGET_MS = 3.5 * 60000;
const PPL_BACKFILL_MAX_RUNS = 20;
const PPL_SP_PAGE = 50;

/** Досыпка с начала. Запустить один раз из редактора; продолжение поставит сама. */
function pplBackfillDirect() { pplBackfillStep_(true); }

/** Продолжение досыпки — его ставит и снимает сама досыпка. */
function pplBackfillDirectNext() { pplBackfillStep_(false); }

function pplBackfillStep_(fresh) {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  let job = null;
  try { job = JSON.parse(props.getProperty(PPL_BACKFILL_KEY) || 'null'); } catch (e) { job = null; }
  if (fresh || !job) job = { bot: 0, skip: 0, rows: 0, runs: 0, done: false };
  pplBackfillDropNext_();
  if (job.done) return;
  job.runs++;
  if (job.runs > PPL_BACKFILL_MAX_RUNS) {
    job.done = true;
    props.setProperty(PPL_BACKFILL_KEY, JSON.stringify(job));
    throw new Error('Досыпка Direct не уложилась в ' + PPL_BACKFILL_MAX_RUNS + ' запусков');
  }
  // продолжение — сразу: оборвёт лимит времени, триггер уже стоит
  ScriptApp.newTrigger('pplBackfillDirectNext').timeBased().after(7 * 60000).create();

  const auth = pplSpAuth_();
  const sh = SpreadsheetApp.openById(pplProp_('SHEET_ID')).getSheetByName(PPL_DIRECT_SHEET);
  const seen = pplBackfillSeen_(sh);
  const since = Date.parse(PPL_BACKFILL_SINCE);
  const until = Date.parse(PPL_BACKFILL_UNTIL);
  const samples = [];

  while (job.bot < PPL_SP_BOTS.length && Date.now() - t0 < PPL_BACKFILL_BUDGET_MS) {
    const bot = PPL_SP_BOTS[job.bot];
    const chats = pplSpGet_(PPL_SP_API + '/chats?bot_id=' + bot[0] + '&size=' + PPL_SP_PAGE + '&skip=' + job.skip, auth) || [];
    const rows = [];
    chats.forEach(function (chat) {
      const c = chat.contact || {};
      if (!c.id || Date.parse(c.last_activity_at || '') < since) return;
      const msgs = pplSpMessages_(c.id, since, auth);
      if (samples.length < 10) msgs.slice(0, 2).forEach(function (m) { samples.push(m); });
      pplBackfillRows_(c, msgs, bot[1], seen, since, until).forEach(function (r) { rows.push(r); });
    });
    pplBackfillAppend_(sh, rows);
    job.rows += rows.length;
    if (chats.length < PPL_SP_PAGE) { job.bot++; job.skip = 0; } else { job.skip += PPL_SP_PAGE; }
    props.setProperty(PPL_BACKFILL_KEY, JSON.stringify(job));
  }
  if (job.runs === 1 && samples.length) pplBackfillSamples_(samples);
  if (job.bot >= PPL_SP_BOTS.length) {
    pplBackfillSort_(sh);
    job.done = true;
    props.setProperty(PPL_BACKFILL_KEY, JSON.stringify(job));
    pplBackfillDropNext_();
  }
  Logger.log('Досыпка Direct: запуск ' + job.runs + ', бот ' + Math.min(job.bot + 1, PPL_SP_BOTS.length) +
    ' из ' + PPL_SP_BOTS.length + (job.done ? ' — готово' : ', продолжение через 7 минут') +
    ', строк дописано всего ' + job.rows + ', ' + Math.round((Date.now() - t0) / 1000) + ' с');
}

/**
 * Авторизация SendPulse — постоянный ключ с вкладки «Ключи API»
 * (sp_apikey_…). Ищем в SP_API_KEY; 27.09.2026 ключ вписали в свойство
 * SP_CLIENT_SECRET — берём и оттуда, если значение похоже на ключ.
 */
function pplSpAuth_() {
  const p = PropertiesService.getScriptProperties();
  const key = [p.getProperty('SP_API_KEY'), p.getProperty('SP_CLIENT_SECRET')]
    .map(function (v) { return String(v || '').trim(); })
    .filter(function (v) { return /^sp_apikey_/.test(v); })[0];
  if (!key) throw new Error('Нет ключа SendPulse: свойство SP_API_KEY = sp_apikey_… (SendPulse → «Доступ к API» → «Ключи API»)');
  return { headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true };
}

/** Снять триггеры продолжения досыпки. */
function pplBackfillDropNext_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'pplBackfillDirectNext') ScriptApp.deleteTrigger(t);
  });
}

/** GET к API SendPulse — поле data ответа; 429 и 5xx — подождать и повторить. */
function pplSpGet_(url, auth) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = UrlFetchApp.fetch(url, auth);
    const code = resp.getResponseCode();
    if (code === 200) {
      const j = JSON.parse(resp.getContentText());
      return j && j.data !== undefined ? j.data : j;
    }
    if (code === 429 || code >= 500) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    throw new Error('SendPulse ' + code + ': ' + pplBriefBody_(resp.getContentText()));
  }
  throw new Error('SendPulse не ответил после повторов: ' + url.split('?')[0]);
}

/**
 * Сообщения переписки. Порядок в ответе API не обещан: листаем страницами,
 * пока страница неполная или (если свежие идут первыми) не ушли раньше since.
 */
function pplSpMessages_(contactId, since, auth) {
  const out = [];
  for (let skip = 0; skip < 3000; skip += 100) {
    const page = pplSpGet_(PPL_SP_API + '/chats/messages?contact_id=' + contactId + '&size=100&skip=' + skip, auth) || [];
    page.forEach(function (m) { out.push(m); });
    if (page.length < 100) break;
    const first = Date.parse(page[0].created_at), last = Date.parse(page[page.length - 1].created_at);
    if (first >= last && last < since) break;
  }
  return out;
}

/**
 * Строки листа по одному человеку: его входящие за [since, until) по
 * порядку и по правилам приёмника — первое за 7 дней, строка с курсом
 * отдельно. Уже записанное (seen: contact_id → [{ t, course }]) в пределах
 * 7 дней в любую сторону не дублируем, а новые строки кладём туда же.
 * Чистая функция, кроме seen.
 */
function pplBackfillRows_(contact, msgs, botName, seen, since, until) {
  const id = String(contact.id);
  const cd = contact.channel_data || {};
  const name = String(cd.name || [cd.first_name, cd.last_name].filter(Boolean).join(' ') || '');
  const mine = seen[id] || (seen[id] = []);
  const week = 7 * 86400000;
  const out = [];
  (msgs || []).filter(function (m) { return Number(m.direction) === 1; })
    .map(function (m) { return { t: Date.parse(m.created_at), data: m.data }; })
    .filter(function (x) { return x.t >= since && x.t < until; })
    .sort(function (a, b) { return a.t - b.t; })
    .forEach(function (x) {
      const text = pplSpText_(x.data);
      const course = pplCourseOf_(text);
      if (mine.some(function (s) { return Math.abs(s.t - x.t) < week && (!course || s.course); })) return;
      const ref = pplSpReferral_(x.data);
      mine.push({ t: x.t, course: course });
      out.push([new Date(x.t).toISOString(), 'instagram', botName, id, String(cd.user_name || ''), name,
        course, pplPrefix_(text), text.slice(0, 500), ref.ad_id || '', ref.ad_title || '', '', '', 0]);
    });
  return out;
}

/** Текст сообщения из data SendPulse: первое поле text (строкой или text.body). Чистая функция. */
function pplSpText_(data) {
  let found = '';
  (function walk(o, depth) {
    if (found || !o || typeof o !== 'object' || depth > 5) return;
    if (typeof o.text === 'string' && o.text.trim()) { found = o.text.trim(); return; }
    if (o.text && typeof o.text.body === 'string' && o.text.body.trim()) { found = o.text.body.trim(); return; }
    Object.keys(o).forEach(function (k) { walk(o[k], depth + 1); });
  })(data, 0);
  return found;
}

/** Referral рекламы — точь-в-точь spReferral_ из webhook.gs. Чистая функция. */
function pplSpReferral_(ev) {
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

/** Текст до двоеточия — точь-в-точь spPrefix_ из webhook.gs. Чистая функция. */
function pplPrefix_(text) {
  const s = String(text || '');
  const i = s.indexOf(':');
  return i > 0 && i <= 60 ? s.slice(0, i).trim() : '';
}

/** Кто уже есть в листе: contact_id → [{ t, course }]. */
function pplBackfillSeen_(sh) {
  const seen = {};
  if (!sh || sh.getLastRow() < 2) return seen;
  sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().forEach(function (r) {
    const t = new Date(r[0]).getTime();
    if (!t) return;
    const id = String(r[3]);
    (seen[id] = seen[id] || []).push({ t: t, course: String(r[6] || '') });
  });
  return seen;
}

/**
 * Дописать строки по одной: приёмник — другой проект со своим замком — пишет
 * в тот же лист, и пачка в «последнюю строку» могла бы затереть его строку.
 */
function pplBackfillAppend_(sh, rows) {
  rows.forEach(function (r) { sh.appendRow(r); });
}

/**
 * Досыпанные строки встали в конец листа, а приёмник ищет повторы, идя от
 * конца, и рассчитывает на хронологию — сортируем по времени. Под замком:
 * pplTagDirectCourses пишет статус по номеру строки.
 */
function pplBackfillSort_(sh) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try {
    const last = sh.getLastRow();
    if (last > 2) sh.getRange(2, 1, last - 1, sh.getLastColumn()).sort({ column: 1, ascending: true });
  } finally {
    lock.releaseLock();
  }
}

/** Первые сообщения первого запуска как есть — сверить формат API с кодом. */
function pplBackfillSamples_(samples) {
  const ss = SpreadsheetApp.openById(pplProp_('SHEET_ID'));
  const sh = ss.getSheetByName(PPL_BACKFILL_RAW) || ss.insertSheet(PPL_BACKFILL_RAW);
  sh.clearContents();
  sh.appendRow(['created_at', 'direction', 'data']);
  samples.forEach(function (m) {
    sh.appendRow([String(m.created_at || ''), String(m.direction || ''), JSON.stringify(m.data || m).slice(0, 5000)]);
  });
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
