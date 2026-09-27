/**
 * Локальные тесты логики склейки из apps-script/people.gs.
 *
 * Apps Script негде прогнать, а именно в склейке живут все нетривиальные
 * решения: кого с кем сопоставлять и что делать с неоднозначностью.
 * Поэтому файл загружается в Node с подменёнными объектами Google и
 * тестируются чистые функции.
 *
 * Запуск: node tests/logic.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

/* ---------- загрузка people.gs с заглушками Google ---------- */

let scriptProps = {};

const sandbox = {
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (k) => scriptProps[k] || null })
  },
  SpreadsheetApp: {}, UrlFetchApp: {}, Utilities: {},
  // в Apps Script карта направлений приходит из build_brands.gs через общую
  // глобальную область; в тестах — уменьшенная копия с теми же правилами
  BRAND_MAP: {
    'каникулы': 'Уикенд',
    'абонементы': 'CODDY + Прознание',
    'регулярные занятия': 'CODDY + Прознание',
    'детали': 'Детали'
  },
  console
};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'people.gs'), 'utf8'),
  sandbox
);

const joinClicksToLeads_ = sandbox.pplJoinClicksToLeads_;
const aggregateByAd_ = sandbox.pplAggregateByAd_;

/* ---------- мини-раннер ---------- */

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/* ---------- фикстуры ---------- */

const click = (igsid, ts, ad_id) => ({ igsid, ts, ad_id, ref: '', ad_title: '', first_text: '' });
const lead = (id, created_at, status, price, igsid) => ({
  id, name: 'Лид ' + id, created_at, status,
  status_id: status === 'won' ? 142 : (status === 'lost' ? 143 : 1),
  price: price || 0, contact_ids: [], igsid: igsid || ''
});

/* ================= сопоставление по IGSID ================= */

console.log('\nСклейка по IGSID');

test('находит сделку по точному IGSID', () => {
  scriptProps = { AMO_IGSID_FIELD: '12345' };
  const out = joinClicksToLeads_(
    [click('u1', '2026-07-01T10:00:00Z', 'ad1')],
    [lead(1, '2026-07-01T12:00:00Z', 'won', 15000, 'u1')]
  );
  assert.strictEqual(out[0].matched, 'igsid');
  assert.strictEqual(out[0].amo_lead_id, 1);
  assert.strictEqual(out[0].revenue, 15000);
});

test('выручка учитывается только у выигранных сделок', () => {
  scriptProps = { AMO_IGSID_FIELD: '12345' };
  const out = joinClicksToLeads_(
    [click('u1', '2026-07-01T10:00:00Z', 'ad1')],
    [lead(1, '2026-07-01T12:00:00Z', 'open', 15000, 'u1')]
  );
  assert.strictEqual(out[0].revenue, 0, 'незакрытая сделка не должна давать выручку');
});

test('клик без сделки помечается как no_deal', () => {
  scriptProps = { AMO_IGSID_FIELD: '12345' };
  const out = joinClicksToLeads_([click('u9', '2026-07-01T10:00:00Z', 'ad1')], []);
  assert.strictEqual(out[0].status, 'no_deal');
  assert.strictEqual(out[0].amo_lead_id, null);
});

/* ================= запасное сопоставление по времени ================= */

console.log('\nСклейка по времени (IGSID не настроен)');

test('единственный кандидат в окне считается совпадением', () => {
  scriptProps = {};
  const out = joinClicksToLeads_(
    [click('u1', '2026-07-01T10:00:00Z', 'ad1')],
    [lead(1, '2026-07-01T12:00:00Z', 'won', 5000)]
  );
  assert.strictEqual(out[0].matched, 'time');
  assert.strictEqual(out[0].amo_lead_id, 1);
});

test('сделка вне окна не подхватывается', () => {
  scriptProps = {};
  const out = joinClicksToLeads_(
    [click('u1', '2026-07-01T10:00:00Z', 'ad1')],
    [lead(1, '2026-07-01T20:00:00Z', 'won', 5000)]   // +10 часов при окне 6
  );
  assert.strictEqual(out[0].matched, 'none');
});

test('сделка раньше клика не подхватывается', () => {
  scriptProps = {};
  const out = joinClicksToLeads_(
    [click('u1', '2026-07-01T10:00:00Z', 'ad1')],
    [lead(1, '2026-07-01T09:00:00Z', 'won', 5000)]
  );
  assert.strictEqual(out[0].matched, 'none');
});

test('несколько кандидатов — не гадаем', () => {
  scriptProps = {};
  const out = joinClicksToLeads_(
    [click('u1', '2026-07-01T10:00:00Z', 'ad1')],
    [lead(1, '2026-07-01T11:00:00Z', 'won', 5000), lead(2, '2026-07-01T12:00:00Z', 'open', 0)]
  );
  assert.strictEqual(out[0].matched, 'ambiguous');
  assert.strictEqual(out[0].amo_lead_id, null);
});

test('одна сделка не достаётся двум разным кликам', () => {
  scriptProps = {};
  const out = joinClicksToLeads_(
    [click('u1', '2026-07-01T10:00:00Z', 'ad1'), click('u2', '2026-07-01T10:30:00Z', 'ad2')],
    [lead(1, '2026-07-01T11:00:00Z', 'won', 5000)]
  );
  const matchedTo = out.filter(p => p.amo_lead_id === 1);
  assert.strictEqual(matchedTo.length, 1, 'сделка не должна засчитаться дважды');
});

/* ================= смешанный режим ================= */

console.log('\nПереходный период: поле IGSID заведено, но заполнено не у всех');

test('сделка без IGSID всё равно подхватывается по времени', () => {
  scriptProps = { AMO_IGSID_FIELD: '12345' };
  const out = joinClicksToLeads_(
    [click('u1', '2026-07-01T10:00:00Z', 'ad1')],
    [lead(1, '2026-07-01T11:00:00Z', 'won', 5000)]   // igsid пустой — старый лид
  );
  assert.strictEqual(out[0].matched, 'time', 'иначе весь переходный период страница пустая');
  assert.strictEqual(out[0].amo_lead_id, 1);
});

test('точное совпадение по IGSID не перехватывается чужим кликом по времени', () => {
  scriptProps = { AMO_IGSID_FIELD: '12345' };
  // клик u2 идёт первым и по времени тоже попадает в окно сделки,
  // но сделка принадлежит u1 по точному идентификатору
  const out = joinClicksToLeads_(
    [click('u2', '2026-07-01T10:00:00Z', 'ad2'), click('u1', '2026-07-01T10:30:00Z', 'ad1')],
    [lead(1, '2026-07-01T11:00:00Z', 'won', 5000, 'u1')]
  );
  const u1 = out.find(p => p.igsid === 'u1');
  const u2 = out.find(p => p.igsid === 'u2');
  assert.strictEqual(u1.amo_lead_id, 1, 'сделка должна достаться владельцу IGSID');
  assert.strictEqual(u1.matched, 'igsid');
  assert.strictEqual(u2.amo_lead_id, null);
});

/* ================= сводка по объявлениям ================= */

console.log('\nСводка по объявлениям');

const spend = {
  ad1: { ad_name: 'Креатив А', campaign_name: 'Кампания', spend: 10000, clicks: 500, impressions: 50000 },
  ad2: { ad_name: 'Креатив Б', campaign_name: 'Кампания', spend: 4000, clicks: 100, impressions: 10000 }
};

test('CAC и ROAS считаются по оплатившим', () => {
  const ads = aggregateByAd_([
    { ad_id: 'ad1', amo_lead_id: 1, status: 'won', revenue: 30000 },
    { ad_id: 'ad1', amo_lead_id: 2, status: 'lost', revenue: 0 },
    { ad_id: 'ad1', amo_lead_id: null, status: 'no_deal', revenue: 0 }
  ], spend);
  const a = ads.find(x => x.ad_id === 'ad1');
  assert.strictEqual(a.wrote, 3);
  assert.strictEqual(a.deals, 2);
  assert.strictEqual(a.won, 1);
  assert.strictEqual(a.cac, 10000);
  assert.strictEqual(a.roas, 3);
});

test('объявление без диалогов всё равно попадает в сводку', () => {
  const ads = aggregateByAd_([{ ad_id: 'ad1', amo_lead_id: 1, status: 'won', revenue: 100 }], spend);
  const b = ads.find(x => x.ad_id === 'ad2');
  assert.ok(b, 'слитый бюджет должен быть виден');
  assert.strictEqual(b.wrote, 0);
  assert.strictEqual(b.spend, 4000);
  assert.strictEqual(b.cac, null, 'CAC без оплативших не определён, а не ноль');
});

test('сортировка по расходу — сверху самое дорогое', () => {
  const ads = aggregateByAd_([], spend);
  assert.strictEqual(ads[0].ad_id, 'ad1');
});

test('клик по объявлению, которого нет в выгрузке Meta, не роняет сводку', () => {
  const ads = aggregateByAd_([{ ad_id: 'ad_удалён', amo_lead_id: 1, status: 'won', revenue: 500 }], spend);
  const a = ads.find(x => x.ad_id === 'ad_удалён');
  assert.strictEqual(a.spend, 0);
  assert.strictEqual(a.roas, null);
});

/* ---------- окупаемость канала ---------- */

const channelSummary_ = sandbox.pplChannelSummary_;
const leadSource_ = sandbox.pplLeadSource_;

// одна валюта у рекламы и у amoCRM — тогда ROAS считается напрямую
const platformSpend = { instagram: 1000, facebook: 400, other: 0, total: 1400, currency: 'BYN', mixed_currency: false };
const AMO_CUR = 'BYN';

function mkLead(o) {
  return Object.assign({
    id: 1, created_at: '2026-07-10T10:00:00.000Z', status: 'open', price: 0, source: ''
  }, o);
}

console.log('\nИсточник заявки из полей amoCRM');

test('источник берётся по названию поля', () => {
  const src = leadSource_({
    custom_fields_values: [
      { field_id: 1, field_name: 'Категория', values: [{ value: 'Новый' }] },
      { field_id: 2, field_name: 'Источник заявки', values: [{ value: 'Instagram' }] }
    ]
  });
  assert.strictEqual(src, 'Instagram');
});

test('сделка без пользовательских полей не роняет разбор', () => {
  assert.strictEqual(leadSource_({}), '');
  assert.strictEqual(leadSource_({ custom_fields_values: null }), '');
});

test('поле есть, но пустое — источник пустой, а не undefined', () => {
  const src = leadSource_({
    custom_fields_values: [{ field_id: 2, field_name: 'Источник заявки', values: [] }]
  });
  assert.strictEqual(src, '');
});

console.log('\nОкупаемость канала');

test('ROAS и CAC считаются по расходу именно в Instagram, а не по всему кабинету', () => {
  const c = channelSummary_([
    mkLead({ id: 1, source: 'Instagram', status: 'won', price: 3000 }),
    mkLead({ id: 2, source: 'Instagram', status: 'open' })
  ], platformSpend, '2026-07-31', AMO_CUR);

  assert.strictEqual(c.instagram.spend, 1000, 'берём только Instagram, не total');
  assert.strictEqual(c.instagram.revenue, 3000);
  assert.strictEqual(c.instagram.roas, 3);
  assert.strictEqual(c.instagram.cac, 1000);
});

test('сделки других источников не попадают в Instagram', () => {
  const c = channelSummary_([
    mkLead({ id: 1, source: 'Instagram', status: 'won', price: 1000 }),
    mkLead({ id: 2, source: 'Звонок', status: 'won', price: 9000 })
  ], platformSpend, '2026-07-31', AMO_CUR);

  assert.strictEqual(c.instagram.revenue, 1000, 'выручка звонков не должна утекать в Instagram');
  assert.strictEqual(c.sources.length, 2);
});

test('источник, записанный иначе, всё равно распознаётся', () => {
  const c = channelSummary_(
    [mkLead({ source: 'instagram direct', status: 'won', price: 500 })],
    platformSpend, '2026-07-31'
  );
  assert.strictEqual(c.instagram.won, 1, 'поиск по вхождению, а не по точному совпадению');
});

test('выигранные сделки без бюджета считаются отдельно', () => {
  const c = channelSummary_([
    mkLead({ id: 1, source: 'Instagram', status: 'won', price: 0 }),
    mkLead({ id: 2, source: 'Instagram', status: 'won', price: 2000 })
  ], platformSpend, '2026-07-31', AMO_CUR);

  assert.strictEqual(c.instagram.won, 2);
  assert.strictEqual(c.instagram.won_without_price, 1, 'иначе заниженная выручка выглядит как факт');
  assert.strictEqual(c.instagram.revenue, 2000);
});

test('доля заполненного источника считается честно', () => {
  const c = channelSummary_([
    mkLead({ id: 1, source: 'Instagram' }),
    mkLead({ id: 2, source: '' }),
    mkLead({ id: 3, source: '' }),
    mkLead({ id: 4, source: 'Звонок' })
  ], platformSpend, '2026-07-31', AMO_CUR);

  assert.strictEqual(c.source_filled, 0.5);
  assert.ok(c.sources.find(s => s.source === '(не указан)'), 'незаполненные видны отдельной строкой');
});

test('сделки, созданные после конца периода, не учитываются', () => {
  const c = channelSummary_([
    mkLead({ id: 1, source: 'Instagram', status: 'won', price: 1000, created_at: '2026-07-10T00:00:00.000Z' }),
    mkLead({ id: 2, source: 'Instagram', status: 'won', price: 5000, created_at: '2026-08-05T00:00:00.000Z' })
  ], platformSpend, '2026-07-31', AMO_CUR);

  assert.strictEqual(c.instagram.won, 1);
  assert.strictEqual(c.instagram.revenue, 1000, 'август не должен попасть в июльский ROAS');
});

test('нет расхода — ROAS не определён, а не бесконечность', () => {
  const c = channelSummary_(
    [mkLead({ source: 'Instagram', status: 'won', price: 700 })],
    { instagram: 0, facebook: 0, other: 0, total: 0, currency: 'BYN', mixed_currency: false }, '2026-07-31', AMO_CUR
  );
  assert.strictEqual(c.instagram.roas, null);
  assert.strictEqual(c.instagram.cac, 0);
});

test('пустой период не роняет расчёт', () => {
  const c = channelSummary_([], platformSpend, '2026-07-31', AMO_CUR);
  assert.strictEqual(c.instagram.leads, 0);
  assert.strictEqual(c.source_filled, 0);
  assert.strictEqual(c.sources.length, 0);
  // расход был, отдачи нет — это честный ноль, а не «не определено»:
  // прочерк спрятал бы слитый бюджет
  assert.strictEqual(c.instagram.roas, 0);
  assert.strictEqual(c.instagram.cac, null, 'а вот CAC без оплативших делить не на что');
});

console.log('\nРазные валюты у рекламы и amoCRM');

const usdSpend = { instagram: 1000, facebook: 0, other: 0, total: 1000, currency: 'USD', mixed_currency: false };

test('без курса ROAS и CAC не считаются вовсе', () => {
  scriptProps = {};
  const c = channelSummary_(
    [mkLead({ source: 'Instagram', status: 'won', price: 12000 })],
    usdSpend, '2026-07-31', 'BYN'
  );
  // 12000 BYN / 1000 USD = 12× — красиво и полностью выдумано
  assert.strictEqual(c.instagram.roas, null, 'нельзя делить рубли на доллары');
  assert.strictEqual(c.instagram.cac, null);
  assert.strictEqual(c.currency.comparable, false);
  assert.strictEqual(c.currency.ads, 'USD');
  assert.strictEqual(c.currency.amo, 'BYN');
});

test('с курсом FX_RATE расход приводится к валюте выручки', () => {
  scriptProps = { FX_RATE: '3' };
  const c = channelSummary_(
    [mkLead({ source: 'Instagram', status: 'won', price: 12000 })],
    usdSpend, '2026-07-31', 'BYN'
  );
  // 1000 USD * 3 = 3000 BYN, выручка 12000 BYN → ROAS 4
  assert.strictEqual(c.instagram.roas, 4);
  assert.strictEqual(c.instagram.cac, 3000);
  assert.strictEqual(c.currency.comparable, true);
  assert.strictEqual(c.currency.rate, 3);
});

test('стоимость заявки остаётся в валюте рекламы и считается всегда', () => {
  scriptProps = {};
  const c = channelSummary_(
    [mkLead({ source: 'Instagram' }), mkLead({ id: 2, source: 'Instagram' })],
    usdSpend, '2026-07-31', 'BYN'
  );
  assert.strictEqual(c.instagram.cost_per_lead, 500, 'тут обе величины из Meta, курс не нужен');
});

test('кабинеты в разных валютах — расчёт запрещён даже при заданном курсе', () => {
  scriptProps = { FX_RATE: '3' };
  const c = channelSummary_(
    [mkLead({ source: 'Instagram', status: 'won', price: 12000 })],
    { instagram: 1000, facebook: 0, other: 0, total: 1000, currency: 'USD', mixed_currency: true },
    '2026-07-31', 'BYN'
  );
  assert.strictEqual(c.currency.comparable, false, 'сложенный расход в разных валютах бессмыслен');
  assert.strictEqual(c.instagram.roas, null);
});

test('валюты совпадают — курс не нужен', () => {
  scriptProps = {};
  const c = channelSummary_(
    [mkLead({ source: 'Instagram', status: 'won', price: 3000 })],
    { instagram: 1000, facebook: 0, other: 0, total: 1000, currency: 'BYN', mixed_currency: false },
    '2026-07-31', 'BYN'
  );
  assert.strictEqual(c.currency.same, true);
  assert.strictEqual(c.instagram.roas, 3);
});

console.log('\nРазрез по воронкам (каникулы отдельно от регулярных)');

const PIPES = { 7407214: 'Регулярные занятия', 10453398: 'Каникулы' };

test('заявки из Instagram разложены по воронкам с названиями', () => {
  scriptProps = {};
  const c = channelSummary_([
    mkLead({ id: 1, source: 'Instagram', pipeline_id: 10453398, status: 'won', price: 900 }),
    mkLead({ id: 2, source: 'Instagram', pipeline_id: 10453398 }),
    mkLead({ id: 3, source: 'Instagram', pipeline_id: 7407214, status: 'lost' })
  ], platformSpend, '2026-07-31', AMO_CUR, PIPES);

  const kanikuly = c.pipelines.find(p => p.pipeline === 'Каникулы');
  assert.strictEqual(kanikuly.leads, 2);
  assert.strictEqual(kanikuly.won, 1);
  assert.strictEqual(kanikuly.revenue, 900);
  assert.strictEqual(c.pipelines.find(p => p.pipeline === 'Регулярные занятия').lost, 1);
});

test('в разрез по воронкам попадают только заявки из Instagram', () => {
  scriptProps = {};
  const c = channelSummary_([
    mkLead({ id: 1, source: 'Instagram', pipeline_id: 10453398 }),
    mkLead({ id: 2, source: 'Звонок', pipeline_id: 10453398, status: 'won', price: 5000 })
  ], platformSpend, '2026-07-31', AMO_CUR, PIPES);

  const kanikuly = c.pipelines.find(p => p.pipeline === 'Каникулы');
  assert.strictEqual(kanikuly.leads, 1, 'звонок не должен приписываться рекламе');
  assert.strictEqual(kanikuly.revenue, 0);
});

test('неизвестная воронка показывается по id, а не теряется', () => {
  scriptProps = {};
  const c = channelSummary_(
    [mkLead({ source: 'Instagram', pipeline_id: 99999 })],
    platformSpend, '2026-07-31', AMO_CUR, PIPES
  );
  assert.strictEqual(c.pipelines[0].pipeline, '99999');
});

test('без справочника воронок расчёт не падает', () => {
  scriptProps = {};
  const c = channelSummary_(
    [mkLead({ source: 'Instagram', pipeline_id: 10453398 })],
    platformSpend, '2026-07-31', AMO_CUR, undefined
  );
  assert.strictEqual(c.pipelines.length, 1);
});

/* ---------- выручка из Альфы ---------- */

const alfaCustomerId_ = sandbox.pplAlfaCustomerId_;

console.log('\nРазбор ссылки на AlfaCRM');

test('id клиента — последняя группа цифр в ссылке', () => {
  assert.strictEqual(alfaCustomerId_('https://proznanie4eee.s20.online/#/customer/4271'), '4271');
});

test('поддомен с цифрами не путается с id', () => {
  // s20 и 4eee в адресе не должны победить настоящий id
  assert.strictEqual(alfaCustomerId_('https://proznanie4eee.s20.online/customers/index/id/3405'), '3405');
});

test('пустая ссылка не роняет разбор', () => {
  assert.strictEqual(alfaCustomerId_(''), '');
  assert.strictEqual(alfaCustomerId_(null), '');
  assert.strictEqual(alfaCustomerId_(undefined), '');
});

test('ссылка без цифр даёт пусто, а не мусор', () => {
  assert.strictEqual(alfaCustomerId_('нет ссылки'), '');
});

/* ---------- нормализация телефона и дат ---------- */

const normPhone_ = sandbox.pplNormPhone_;
const anyIso_ = sandbox.pplAnyIso_;

console.log('\nНормализация телефона (мост держится на ней)');

test('формат Альфы «+375(29)110-27-96» приводится к E.164', () => {
  assert.strictEqual(normPhone_('+375(29)110-27-96'), '+375291102796');
});

test('городской формат 80291234567 получает код страны', () => {
  assert.strictEqual(normPhone_('80291234567'), '+375291234567');
});

test('локальные 9 цифр дополняются до полного номера', () => {
  assert.strictEqual(normPhone_('291234567'), '+375291234567');
});

test('мусор и обрезки отбраковываются', () => {
  assert.strictEqual(normPhone_('335'), '');
  assert.strictEqual(normPhone_(''), '');
  assert.strictEqual(normPhone_(null), '');
});

console.log('\nДаты из ячеек листа');

test('объект Date превращается в ISO', () => {
  assert.strictEqual(anyIso_(new Date(2026, 6, 15)), '2026-07-15');
});

test('формат Альфы «ДД.ММ.ГГГГ» разворачивается в ISO', () => {
  assert.strictEqual(anyIso_('15.07.2026'), '2026-07-15');
});

test('ISO-строка с временем обрезается до даты', () => {
  assert.strictEqual(anyIso_('2026-07-15T10:00:00Z'), '2026-07-15');
});

test('нечитаемое значение даёт пусто, а не NaN', () => {
  assert.strictEqual(anyIso_('вчера'), '');
  assert.strictEqual(anyIso_(''), '');
});

/* ---------- слияние утреннего листа с живой дельтой ---------- */

const mergeRows_ = sandbox.pplMergeRows_;

console.log('\nЖивая дельта поверх утреннего листа');

test('строка дельты заменяет листовую с тем же ключом', () => {
  const merged = mergeRows_(
    [{ lead_id: 1, source: '' }, { lead_id: 2, source: 'Звонок' }],
    [{ lead_id: 1, source: 'Instagram' }],
    'lead_id'
  );
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].source, 'Instagram', 'менеджер проставил источник — дельта победила');
});

test('новые строки дельты добавляются', () => {
  const merged = mergeRows_(
    [{ pay_id: 'p1', income: 100 }],
    [{ pay_id: 'p2', income: 200 }],
    'pay_id'
  );
  assert.strictEqual(merged.length, 2);
});

test('пустая дельта возвращает лист без изменений', () => {
  const base = [{ lead_id: 1 }];
  assert.strictEqual(mergeRows_(base, [], 'lead_id'), base);
});

test('строки без ключа в дельте игнорируются', () => {
  const merged = mergeRows_([{ lead_id: 1 }], [{ lead_id: '' }, { lead_id: 2 }], 'lead_id');
  assert.strictEqual(merged.length, 2);
});

/* ---------- ядро выручки: мост по телефону ---------- */

const revenueCore_ = sandbox.pplAlfaRevenueCore_;

console.log('\nВыручка из Альфы: мост по телефону');

const igLead = (over) => Object.assign({
  created_at: '2026-07-10', phone_e164: '+375291102796', source: 'Instagram',
  pipeline: 'Каникулы', alfa_url: '', contact_id: ''
}, over);
const customer = (id, phones, amoContact) => ({
  customer_id: id, branches: '4', phones: phones,
  amo_contact_id: amoContact || '', created_at: '', name: 'Клиент ' + id
});
const pay = (cid, date, income, payId) => ({
  document_date: date, customer_id: cid, income: income, branch: '4',
  pay_item_id: '', payer_name: '', pay_id: payId
});

test('заявка находит клиента по телефону, платёж после заявки считается', () => {
  const r = revenueCore_(
    [igLead({})],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.with_alfa, 1);
  assert.strictEqual(r.paid_customers, 1);
  assert.strictEqual(r.revenue, 250);
  assert.strictEqual(r.brands[0].brand, 'Уикенд');
});

test('платёж раньше заявки не приписывается рекламе', () => {
  const r = revenueCore_(
    [igLead({ created_at: '2026-07-10' })],
    [customer(101, '+375291102796')],
    [pay(101, '05.07.2026', 999, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.with_alfa, 1, 'клиент найден');
  assert.strictEqual(r.revenue, 0, 'но его старые деньги — не заслуга рекламы');
});

test('заявка без телефона честно остаётся несвязанной', () => {
  const r = revenueCore_(
    [igLead({ phone_e164: '' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.leads, 1);
  assert.strictEqual(r.with_phone, 0);
  assert.strictEqual(r.with_alfa, 0);
  assert.strictEqual(r.revenue, 0);
});

test('семья: два ребёнка на одном номере — деньги обоих, но один раз', () => {
  const r = revenueCore_(
    [igLead({})],
    [customer(101, '+375291102796'), customer(102, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1'), pay(102, '20.07.2026', 300, 'p2')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.paid_customers, 1, 'семья считается одной оплатившей заявкой');
  assert.strictEqual(r.revenue, 550);
});

test('повторная заявка того же клиента деньги не задваивает', () => {
  const r = revenueCore_(
    [igLead({ created_at: '2026-07-10' }), igLead({ created_at: '2026-07-12' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.with_alfa, 2, 'обе заявки связаны');
  assert.strictEqual(r.paid_customers, 1);
  assert.strictEqual(r.revenue, 250, 'платёж учтён один раз');
});

test('дубль платежа с тем же pay_id считается один раз', () => {
  const r = revenueCore_(
    [igLead({})],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p7'), pay(101, '15.07.2026', 250, 'p7')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.revenue, 250, 'зеркальные филиалы не должны задваивать сумму');
});

test('у клиента несколько номеров через точку с запятой — работает любой', () => {
  const r = revenueCore_(
    [igLead({ phone_e164: '+375447123292' })],
    [customer(101, '+375291102796;+375447123292')],
    [pay(101, '15.07.2026', 100, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.with_alfa, 1);
  assert.strictEqual(r.revenue, 100);
});

test('заполненная ссылка на Альфу приоритетнее телефона', () => {
  const r = revenueCore_(
    [igLead({ alfa_url: 'https://proznanie4eee.s20.online/#/customer/777' })],
    [customer(101, '+375291102796')],
    [pay(777, '15.07.2026', 400, 'p1'), pay(101, '15.07.2026', 100, 'p2')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.revenue, 400, 'деньги взяты у клиента из ссылки, а не по телефону');
});

test('заявка без телефона находит клиента по id контакта amo', () => {
  const r = revenueCore_(
    [igLead({ phone_e164: '', contact_id: '40464221' })],
    [customer(101, '', '40464221')],
    [pay(101, '15.07.2026', 300, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.with_alfa, 1);
  assert.strictEqual(r.revenue, 300);
});

test('контакт amo приоритетнее телефона', () => {
  const r = revenueCore_(
    [igLead({ contact_id: '40464221' })],   // телефон тоже задан, но контакт точнее
    [customer(101, '+375291102796'), customer(202, '', '40464221')],
    [pay(101, '15.07.2026', 100, 'p1'), pay(202, '15.07.2026', 500, 'p2')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.revenue, 500, 'деньги клиента, привязанного по контакту');
});

test('неизвестный контакт не мешает мосту по телефону', () => {
  const r = revenueCore_(
    [igLead({ contact_id: '99999999' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.with_alfa, 1, 'телефон остаётся запасным путём');
  assert.strictEqual(r.revenue, 250);
});

test('воронка вне карты направлений видна отдельной строкой', () => {
  const r = revenueCore_(
    [igLead({ pipeline: 'Тест' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 50, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.brands[0].brand, '(вне карты направлений)');
});

test('заявка не из Instagram в расчёт не попадает', () => {
  const r = revenueCore_(
    [igLead({ source: 'Звонок' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.leads, 0);
  assert.strictEqual(r.revenue, 0);
});

test('заявка вне периода в расчёт не попадает', () => {
  const r = revenueCore_(
    [igLead({ created_at: '2026-06-10' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.leads, 0);
});

test('пофамильный список оплативших: имя, направление, дата, сумма', () => {
  const r = revenueCore_(
    [igLead({})],
    [customer(101, '+375291102796'), customer(102, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1'), pay(102, '20.07.2026', 300, 'p2')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.paid_list.length, 2, 'каждый ребёнок семьи — отдельной строкой');
  assert.strictEqual(r.paid_list[0].name, 'Клиент 102', 'сортировка по сумме, богатые сверху');
  assert.strictEqual(r.paid_list[0].revenue, 300);
  assert.strictEqual(r.paid_list[1].revenue, 250);
  assert.strictEqual(r.paid_list[0].brand, 'Уикенд');
  assert.strictEqual(r.paid_list[0].lead_date, '2026-07-10');
  const total = r.paid_list.reduce((s, p) => s + p.revenue, 0);
  assert.strictEqual(total, r.revenue, 'сумма списка сходится с общей выручкой');
});

test('клиент без платежей в список оплативших не попадает', () => {
  const r = revenueCore_(
    [igLead({})],
    [customer(101, '+375291102796')],
    [pay(101, '05.07.2026', 999, 'p1')],   // платёж раньше заявки
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.paid_list.length, 0);
});

test('выручка по источникам считается и для не-Instagram заявок', () => {
  const r = revenueCore_(
    [igLead({ source: 'Звонок' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.revenue, 0, 'сводные метрики остаются только про Instagram');
  const call = r.by_source.find(s => s.source === 'Звонок');
  assert.strictEqual(call.paid, 1);
  assert.strictEqual(call.revenue, 250, 'а разрез по источникам видит деньги звонка');
});

test('клиент, пришедший двумя каналами, виден в обеих строках источников', () => {
  const r = revenueCore_(
    [igLead({}), igLead({ source: 'Звонок' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  const ig = r.by_source.find(s => s.source === 'Instagram');
  const call = r.by_source.find(s => s.source === 'Звонок');
  assert.strictEqual(ig.revenue, 250, 'строка отвечает «сколько принесли пришедшие отсюда»');
  assert.strictEqual(call.revenue, 250);
});

test('разрез по воронкам содержит только Instagram-заявки', () => {
  const r = revenueCore_(
    [igLead({ pipeline: 'Каникулы' }), igLead({ source: 'Звонок', pipeline: 'Детали' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.ok(r.by_pipeline.find(p => p.pipeline === 'Каникулы'));
  assert.strictEqual(r.by_pipeline.find(p => p.pipeline === 'Детали'), undefined,
    'воронка звонка не должна попадать в рекламный разрез');
});

test('даты-объекты из листа сравниваются с датой заявки правильно', () => {
  const r = revenueCore_(
    [igLead({ created_at: new Date(2026, 6, 10) })],
    [customer(101, '+375291102796')],
    [pay(101, new Date(2026, 6, 15), 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.revenue, 250);
});

/* ---------- «крутится прямо сейчас» ---------- */
// Ловушка Meta: у кампании с законченным расписанием объявление
// продолжает отдаваться как ACTIVE. Без проверки дат отчёт показывал
// 325 «активных» кампаний вместо десятка — все поднятые за годы посты.

const isDelivering_ = sandbox.pplIsDelivering_;
const NOW = Date.parse('2026-09-07T19:00:00Z');

console.log('\nЧто крутится прямо сейчас');

test('активное объявление без конца расписания крутится', () => {
  assert.strictEqual(isDelivering_({ effective_status: 'ACTIVE' }, NOW), true);
});

test('активное с концом расписания в будущем крутится', () => {
  assert.strictEqual(isDelivering_({
    effective_status: 'ACTIVE',
    adset: { end_time: '2026-09-30T00:00:00+0300' }
  }, NOW), true);
});

test('поднятая публикация с законченным расписанием не крутится', () => {
  assert.strictEqual(isDelivering_({
    effective_status: 'ACTIVE',
    adset: { end_time: '2024-05-01T00:00:00+0300' }
  }, NOW), false);
});

test('остановленная по времени кампания забирает объявление', () => {
  assert.strictEqual(isDelivering_({
    effective_status: 'ACTIVE',
    campaign: { stop_time: '2026-09-01T00:00:00+0300' }
  }, NOW), false);
});

test('выключенная группа: объявление приходит как ADSET_PAUSED', () => {
  assert.strictEqual(isDelivering_({ effective_status: 'ADSET_PAUSED' }, NOW), false);
});

test('статуса нет вовсе — не считаем крутящимся', () => {
  assert.strictEqual(isDelivering_({}, NOW), false);
});

/* ---------- доставляет ли кабинет ---------- */
// Когда не проходит платёж, Meta глушит показы на уровне кабинета, а у
// объявлений остаётся ACTIVE и расписание в будущем.

const accountDelivers_ = sandbox.pplAccountDelivers_;

console.log('\nСостояние рекламного кабинета');

test('рабочий кабинет доставляет', () => {
  assert.strictEqual(accountDelivers_({ ok: true, cap_reached: false }), true);
});

test('остановленный кабинет не доставляет', () => {
  assert.strictEqual(accountDelivers_({ ok: false, cap_reached: false }), false);
});

test('упёрлись в лимит затрат — показов нет', () => {
  assert.strictEqual(accountDelivers_({ ok: true, cap_reached: true }), false);
});

test('Meta не ответила — не поднимаем ложную тревогу', () => {
  assert.strictEqual(accountDelivers_(undefined), true);
});

/* ---------- метрики Meta Ads ---------- */
// Эти хелперы обслуживают и дни, и профили, и разбивку по объявлениям,
// и «Сейчас активно» — ошибка в них разъедется сразу по четырём отчётам.

const addMetrics_ = sandbox.pplAddMetrics_;
const sumMetrics_ = sandbox.pplSumMetrics_;
const zeroMetrics_ = sandbox.pplZeroMetrics_;
const budget_ = sandbox.pplBudget_;

console.log('\nМетрики Meta Ads');

test('строка Insights складывается в накопитель', () => {
  const row = addMetrics_(zeroMetrics_(), {
    spend: '12.34', impressions: '1000', clicks: '40', inline_link_clicks: '25',
    actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' }]
  });
  assert.strictEqual(row.spend, 12.34);
  assert.strictEqual(row.impressions, 1000);
  assert.strictEqual(row.clicks, 40);
  assert.strictEqual(row.link_clicks, 25);
  assert.strictEqual(row.messages, 3);
});

test('в сообщения попадают только начатые переписки', () => {
  const row = addMetrics_(zeroMetrics_(), {
    spend: '1', actions: [
      { action_type: 'link_click', value: '99' },
      { action_type: 'post_engagement', value: '55' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '2' }
    ]
  });
  assert.strictEqual(row.messages, 2);
});

test('пустая строка Insights ничего не ломает', () => {
  assert.deepStrictEqual(addMetrics_(zeroMetrics_(), {}), zeroMetrics_());
});

test('накопитель суммирует несколько дней', () => {
  const row = zeroMetrics_();
  addMetrics_(row, { spend: '1.5', impressions: '10', inline_link_clicks: '2' });
  addMetrics_(row, { spend: '2.5', impressions: '20', inline_link_clicks: '3' });
  assert.strictEqual(row.spend, 4);
  assert.strictEqual(row.impressions, 30);
  assert.strictEqual(row.link_clicks, 5);
});

test('итог по списку строк', () => {
  const t = sumMetrics_([
    { spend: 1, impressions: 10, clicks: 2, link_clicks: 1, messages: 1 },
    { spend: 2, impressions: 20, clicks: 3, link_clicks: 2, messages: 0 }
  ]);
  // ожидание строим тем же хелпером: объект из vm-песочницы лежит на чужом
  // Object.prototype, и deepStrictEqual с литералом падает на прототипе
  const exp = zeroMetrics_();
  exp.spend = 3; exp.impressions = 30; exp.clicks = 5; exp.link_clicks = 3; exp.messages = 1;
  assert.deepStrictEqual(t, exp);
});

test('итог по пустому списку — нули, а не NaN', () => {
  assert.deepStrictEqual(sumMetrics_([]), zeroMetrics_());
});

test('бюджет Meta приходит в центах строкой', () => {
  assert.strictEqual(budget_('800'), 8);
  assert.strictEqual(budget_(null), 0);
  assert.strictEqual(budget_(undefined), 0);
});

test('качество переписок: новые люди, блокировки и глубина — каждое в свою метрику', () => {
  const row = addMetrics_(zeroMetrics_(), {
    spend: '10', actions: [
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' },
      { action_type: 'onsite_conversion.messaging_first_reply', value: '3' },
      { action_type: 'onsite_conversion.messaging_block', value: '1' },
      { action_type: 'onsite_conversion.messaging_user_depth_2_message_send', value: '3' },
      { action_type: 'onsite_conversion.messaging_user_depth_3_message_send', value: '2' },
      { action_type: 'onsite_conversion.messaging_user_subscribed', value: '9' }
    ]
  });
  assert.strictEqual(row.messages, 4, 'новые и блокировки не должны попасть в «сообщений»');
  assert.strictEqual(row.new_chats, 3);
  assert.strictEqual(row.blocks, 1);
  assert.strictEqual(row.depth2, 3);
  assert.strictEqual(row.depth3, 2);
});

test('глубины разговора нет в строке, пока Meta её не прислала, — и в итоге тоже', () => {
  const plain = addMetrics_(zeroMetrics_(), { actions: [
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '2' }] });
  assert.strictEqual('depth2' in plain, false, 'нули глубины зря раздували бы отчёт');
  assert.strictEqual('depth3' in sumMetrics_([plain, plain]), false);
  const deep = addMetrics_(zeroMetrics_(), { actions: [
    { action_type: 'onsite_conversion.messaging_user_depth_3_message_send', value: '1' }] });
  assert.strictEqual(sumMetrics_([plain, deep]).depth3, 1);
  assert.strictEqual(sandbox.pplMinusMetrics_(sumMetrics_([deep, deep]), deep).depth3, 1);
});

test('старый накопитель без новых полей не превращается в NaN', () => {
  const old = { spend: 0, impressions: 0, clicks: 0, link_clicks: 0, messages: 0 };
  addMetrics_(old, { actions: [{ action_type: 'onsite_conversion.messaging_block', value: '2' }] });
  assert.strictEqual(old.blocks, 2);
});

test('итог складывает и метрики качества, охват в итог не идёт', () => {
  const t = sumMetrics_([
    { spend: 1, messages: 2, new_chats: 1, blocks: 0, depth3: 1, reach: 500, frequency: 2 },
    { spend: 2, messages: 3, new_chats: 2, blocks: 1, depth3: 0, reach: 700, frequency: 3 }
  ]);
  assert.strictEqual(t.messages, 5);
  assert.strictEqual(t.new_chats, 3);
  assert.strictEqual(t.blocks, 1);
  assert.strictEqual(t.depth3, 1);
  assert.strictEqual(t.reach, undefined, 'охваты разных объявлений складывать нельзя');
});

const minusMetrics_ = sandbox.pplMinusMetrics_;
const msgTypes_ = sandbox.pplMsgTypes_;

test('неделя до последней = 14 дней минус 7, без минусов от округления', () => {
  const two = zeroMetrics_(); Object.assign(two, { spend: 30.1, impressions: 9000, messages: 12, new_chats: 5 });
  const week = zeroMetrics_(); Object.assign(week, { spend: 20.05, impressions: 5000, messages: 13, new_chats: 2 });
  const prev = minusMetrics_(two, week);
  assert.strictEqual(prev.spend, 10.05);
  assert.strictEqual(prev.impressions, 4000);
  assert.strictEqual(prev.messages, 0, 'расхождение Meta на единицу не даёт −1');
  assert.strictEqual(prev.new_chats, 3);
});

test('виды переписочных действий — без повторов и без чужих', () => {
  const types = msgTypes_([
    { actions: [{ action_type: 'link_click' }, { action_type: 'onsite_conversion.messaging_block' }] },
    { actions: [{ action_type: 'onsite_conversion.messaging_block' },
                { action_type: 'onsite_conversion.messaging_first_reply' }] },
    {}
  ]);
  assert.deepStrictEqual([...types],
    ['onsite_conversion.messaging_block', 'onsite_conversion.messaging_first_reply']);
});

/* ---------- выгорание креатива ---------- */

console.log('\nВыгорание креатива');

const burnout_ = sandbox.pplBurnout_;
const wk = (o) => Object.assign(zeroMetrics_(), { impressions: 5000, link_clicks: 100 }, o);

test('высокая частота и сообщение подорожало на 50% — выгорает', () => {
  const b = burnout_(wk({ spend: 60, messages: 40, frequency: 3.4 }), wk({ spend: 40, messages: 40 }));
  assert.strictEqual(b.level, 'hot');
  assert.ok(/частота 3,4/.test(b.reason) && /50%/.test(b.reason), b.reason);
});

test('то же подорожание при низкой частоте — не креатив, молчим', () => {
  const b = burnout_(wk({ spend: 60, messages: 40, frequency: 2.2 }), wk({ spend: 40, messages: 40 }));
  assert.strictEqual(b.level, '');
});

test('очень высокая частота без подорожания — предупреждение, но не «выгорает»', () => {
  const b = burnout_(wk({ spend: 40, messages: 40, frequency: 5 }), wk({ spend: 40, messages: 40 }));
  assert.strictEqual(b.level, 'warn');
});

test('сообщений за неделю ни одного, а денег ушло как на два прежних — выгорает', () => {
  const b = burnout_(wk({ spend: 7, messages: 0, frequency: 3.5 }), wk({ spend: 30, messages: 10 }));
  assert.strictEqual(b.level, 'hot');
  assert.ok(/ни одного/.test(b.reason), b.reason);
});

test('мало показов — не судим даже при высокой частоте', () => {
  const b = burnout_(wk({ impressions: 600, spend: 60, messages: 10, frequency: 6 }),
    wk({ spend: 10, messages: 10 }));
  assert.strictEqual(b.level, '');
});

test('новое объявление: сравнивать не с чем, частота умеренная — молчим', () => {
  const b = burnout_(wk({ spend: 20, messages: 10, frequency: 3.5 }), zeroMetrics_());
  assert.strictEqual(b.level, '');
});

test('объявление без переписок: CTR упал вдвое при высокой частоте — выгорает', () => {
  const b = burnout_(wk({ spend: 20, link_clicks: 20, frequency: 3.2 }), wk({ spend: 20, link_clicks: 40 }));
  assert.strictEqual(b.level, 'hot');
  assert.ok(/50% реже/.test(b.reason), b.reason);
});

test('сообщение подешевело, хоть CTR и упал, — не выгорание', () => {
  const b = burnout_(wk({ spend: 30, messages: 40, link_clicks: 50, frequency: 3.6 }),
    wk({ spend: 40, messages: 40, link_clicks: 100 }));
  assert.strictEqual(b.level, '');
});

/* ---------- разрезы аудитории ---------- */

console.log('\nРазрезы аудитории');

const localHour_ = sandbox.pplLocalHour_;
const weekday_ = sandbox.pplWeekday_;
const ageGenderOrder_ = sandbox.pplAgeGenderOrder_;
const graphRows_ = sandbox.pplGraphRows_;

test('час показа переводится из пояса кабинета в минский', () => {
  assert.strictEqual(localHour_('14:00:00 - 14:59:59', 3), 14, 'кабинет уже по Минску');
  assert.strictEqual(localHour_('14:00:00 - 14:59:59', 0), 17, 'UTC → +3');
  assert.strictEqual(localHour_('23:00:00 - 23:59:59', 0), 2, 'через полночь');
  assert.strictEqual(localHour_('10:00:00 - 10:59:59', -7), 20, 'Лос-Анджелес летом');
  assert.strictEqual(localHour_('08:00:00 - 08:59:59', null), 8, 'пояс неизвестен — как есть');
  assert.strictEqual(localHour_('', 3), null);
});

test('день недели: понедельник — 1, воскресенье — 7', () => {
  assert.strictEqual(weekday_('2026-09-27'), 7);
  assert.strictEqual(weekday_('2026-09-28'), 1);
  assert.strictEqual(weekday_('2026-10-03'), 6);
});

test('возраст по порядку, неизвестный в конце, внутри — женщины, потом мужчины', () => {
  const rows = [
    { age: 'Unknown', gender: 'unknown' }, { age: '35-44', gender: 'male' },
    { age: '25-34', gender: 'male' }, { age: '35-44', gender: 'female' },
    { age: '65+', gender: 'female' }, { age: '25-34', gender: 'unknown' },
    { age: '25-34', gender: 'female' }
  ];
  const got = rows.sort(ageGenderOrder_).map(r => r.age + ' ' + r.gender);
  assert.deepStrictEqual(got, [
    '25-34 female', '25-34 male', '25-34 unknown', '35-44 female', '35-44 male',
    '65+ female', 'Unknown unknown'
  ]);
});

test('разрезы по профилям: каждое объявление в свой профиль, «все вместе» — сумма', () => {
  const act = (o) => Object.assign({ account: 'act_1', spend: '10', impressions: '1000',
    actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '2' }] }, o);
  const rows = [
    [act({ ad_id: 'd1', age: '35-44', gender: 'female' }), act({ ad_id: 'c1', age: '35-44', gender: 'female' }),
     act({ ad_id: 'x9', age: '25-34', gender: 'male' })],
    [act({ ad_id: 'd1', publisher_platform: 'instagram', platform_position: 'instagram_reels' })],
    [act({ ad_id: 'c1', hourly_stats_aggregated_by_advertiser_time_zone: '17:00:00 - 17:59:59', account: 'act_2' })],
    [act({ ad_id: 'd1', date_start: '2026-09-27', spend: '10.1' }), act({ ad_id: 'c1', date_start: '2026-09-28', spend: '20.2' })]
  ];
  const g = sandbox.pplAudienceGroups_(rows, { d1: 'DETALI', c1: 'CODDY' }, { act_1: 3, act_2: 0 });
  assert.deepStrictEqual(Object.keys(g).sort(), ['*', '?', 'CODDY', 'DETALI']);
  assert.strictEqual(g['*'].totals.spend, 30.3, 'сумма без хвоста float');
  assert.strictEqual(g.DETALI.totals.spend, 10.1);
  assert.strictEqual(g.CODDY.totals.messages, 2);
  assert.strictEqual(g['*'].age_gender.length, 2, 'женщины 35–44 обоих профилей — одна строка');
  assert.strictEqual(g['*'].age_gender[1].spend, 20);
  assert.strictEqual(g.DETALI.age_gender.length, 1);
  assert.strictEqual(g['?'].age_gender[0].gender, 'male', 'объявление без профиля не теряется');
  assert.strictEqual(g['?'].profile_id, '');
  assert.strictEqual(g.DETALI.placements[0].position, 'instagram_reels');
  assert.strictEqual(g.CODDY.placements.length, 0);
  assert.strictEqual(g.CODDY.hours.length, 24, 'у профиля с часами — все 24 часа');
  assert.strictEqual(g.CODDY.hours[20].spend, 10, 'кабинет в UTC: 17 ч → 20 ч по Минску');
  assert.strictEqual(g.DETALI.hours.length, 0, 'у профиля без почасовых строк часов нет');
  assert.strictEqual(g.DETALI.weekdays[6].dow, 7, 'воскресенье');
  assert.strictEqual(g.DETALI.weekdays[6].spend, 10.1);
});

test('разрезы без строк — пустая группа «все вместе», а не падение', () => {
  const g = sandbox.pplAudienceGroups_([[], [], [], []], {}, {});
  assert.deepStrictEqual(Object.keys(g), ['*']);
  assert.strictEqual(g['*'].totals.spend, 0);
  assert.strictEqual(g['*'].hours.length, 0);
  assert.strictEqual(g['*'].weekdays.length, 7);
});

test('строки ответа Meta: нет тела — ok=false, одна страница — все строки', () => {
  const none = graphRows_(null, 5);
  assert.strictEqual(none.ok, false);
  assert.strictEqual(none.rows.length, 0);
  const one = graphRows_({ data: [{ a: 1 }, { a: 2 }], paging: { cursors: {} } }, 5);
  assert.strictEqual(one.ok, true);
  assert.strictEqual(one.rows.length, 2);
});

/* ================= курс из первого сообщения в Direct ================= */

console.log('\nКурс из Direct: разрез выручки');

test('разрез по курсам: метка из utm_campaign, без метки — «курс не определён»', () => {
  const r = revenueCore_(
    [igLead({ utm_campaign: 'Minecraft' }), igLead({ phone_e164: '', utm_campaign: '' })],
    [customer(101, '+375291102796')],
    [pay(101, '15.07.2026', 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  const mc = r.by_course.find(c => c.course === 'Minecraft');
  const none = r.by_course.find(c => c.course === '(курс не определён)');
  assert.strictEqual(mc.leads, 1);
  assert.strictEqual(mc.paid, 1);
  assert.strictEqual(mc.revenue, 250);
  assert.strictEqual(none.leads, 1);
  assert.strictEqual(none.revenue, 0);
});

test('разрез по курсам не берёт заявки не из Instagram', () => {
  const r = revenueCore_(
    [igLead({ source: 'Сайт', utm_campaign: 'autumn_sale' })],
    [], [], '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.by_course.length, 0, 'настоящие UTM сайта не смешиваются с курсами');
});

console.log('\nКурс из Direct: какая сделка та самая');

const pickLead_ = sandbox.pplPickDirectLead_;
const directContacts_ = sandbox.pplDirectContacts_;
const leadField_ = sandbox.pplLeadFieldValue_;
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('берёт сделку, созданную около момента сообщения', () => {
  const l = pickLead_('2026-09-26T10:29:00Z', [
    { id: 1, created_at: unix('2026-08-01T10:00:00Z'), updated_at: unix('2026-08-02T10:00:00Z'), status_id: 142 },
    { id: 2, created_at: unix('2026-09-26T10:30:00Z'), updated_at: unix('2026-09-26T10:31:00Z'), status_id: 1 }
  ]);
  assert.strictEqual(l.id, 2);
});

test('новой сделки нет — берёт открытую, которую тронули на этом сообщении', () => {
  const l = pickLead_('2026-09-26T10:29:00Z', [
    { id: 1, created_at: unix('2026-08-01T10:00:00Z'), updated_at: unix('2026-09-26T10:29:30Z'), status_id: 5 }
  ]);
  assert.strictEqual(l.id, 1);
});

test('старые и закрытые сделки не трогает', () => {
  const l = pickLead_('2026-09-26T10:29:00Z', [
    { id: 1, created_at: unix('2026-08-01T10:00:00Z'), updated_at: unix('2026-09-26T10:29:30Z'), status_id: 143 },
    { id: 2, created_at: unix('2026-08-01T10:00:00Z'), updated_at: unix('2026-09-01T10:00:00Z'), status_id: 5 }
  ]);
  assert.strictEqual(l, null);
});

test('контакт берётся только при совпадении имени с ником или именем', () => {
  const out = directContacts_(
    { username: 'AnnaKrutenko', name: 'Анна' },
    [{ id: 1, name: 'annakrutenko' }, { id: 2, name: 'Анна Иванова' }, { id: 3, name: '@AnnaKrutenko' }]
  );
  assert.deepStrictEqual(out.map(c => c.id), [1, 3]);
});

test('контакт «Фамилия Имя» находится по профилю «Имя Фамилия»', () => {
  // так amoCRM назвал контакт на тестовое сообщение 26.09.2026
  const out = directContacts_(
    { username: 'jane3dmp', name: 'Jane Mp' },
    [{ id: 1, name: 'Mp Jane' }, { id: 2, name: 'Jane Smith' }, { id: 3, name: 'Jane Mp' }]
  );
  assert.deepStrictEqual(out.map(c => c.id), [1, 3]);
});

test('эмодзи и знаки в имени профиля не мешают совпадению', () => {
  const out = directContacts_(
    { username: 'diana_k', name: 'Diana💎' },
    [{ id: 1, name: 'Diana' }, { id: 2, name: 'Диана' }, { id: 3, name: '💎' }]
  );
  assert.deepStrictEqual(out.map(c => c.id), [1]);
});

const pickEvent_ = sandbox.pplPickChatEventLead_;
const directPatch_ = sandbox.pplDirectPatch_;
const chatEv = (lead, iso, origin) => ({
  entity_type: 'lead', entity_id: lead, created_at: unix(iso),
  value_after: [{ message: { origin: origin || 'instagram_business', talk_id: 1 } }]
});

test('сделка по событию «входящее сообщение» — ближайшая к вебхуку', () => {
  // 26.09.2026: сообщение про английский amoCRM подшил в старую сделку
  // клиента за 2 с до вебхука SendPulse, через 19 с написал другой человек
  const id = pickEvent_('2026-09-26T15:30:59Z', [
    chatEv(38873133, '2026-09-26T15:31:18Z'),
    chatEv(37034381, '2026-09-26T15:30:57Z')
  ]);
  assert.strictEqual(id, 37034381);
});

test('события не из Instagram, не по сделке и вне окна не берутся', () => {
  const id = pickEvent_('2026-09-26T15:30:59Z', [
    chatEv(1, '2026-09-26T15:30:58Z', 'viber'),
    chatEv(2, '2026-09-26T15:20:00Z'),
    Object.assign(chatEv(3, '2026-09-26T15:30:57Z'), { entity_type: 'contact' })
  ]);
  assert.strictEqual(id, 0);
});

test('двое написали почти одновременно — сделку по событию не угадываем', () => {
  const id = pickEvent_('2026-09-26T15:30:59Z', [
    chatEv(1, '2026-09-26T15:30:57Z'),
    chatEv(2, '2026-09-26T15:30:58Z')
  ]);
  assert.strictEqual(id, 0);
});

test('несколько сообщений одного человека подряд — одна сделка', () => {
  const id = pickEvent_('2026-09-26T15:30:59Z', [
    chatEv(7, '2026-09-26T15:30:57Z'),
    chatEv(7, '2026-09-26T15:30:58Z')
  ]);
  assert.strictEqual(id, 7);
});

test('новая сделка: курс в utm_campaign, объявление в utm_content, тег', () => {
  const p = directPatch_(
    { ts: '2026-09-26T15:20:05Z', course: 'Minecraft', ad_id: '120' },
    { id: 5, created_at: unix('2026-09-26T15:20:01Z') }
  );
  assert.strictEqual(p.status, 'ok');
  assert.strictEqual(p.patch.custom_fields_values.map(f => f.values[0].value).join('|'), 'Minecraft|120');
  assert.strictEqual(JSON.stringify(p.patch.tags_to_add), JSON.stringify([{ name: 'курс: Minecraft' }]));
});

test('старая сделка клиента: только тег, поля не трогаем', () => {
  // иначе английский приписался бы к оплатам за Roblox из этой сделки
  const p = directPatch_(
    { ts: '2026-09-26T15:30:59Z', course: 'Английский', ad_id: '' },
    { id: 37034381, created_at: unix('2026-05-14T06:18:00Z') }
  );
  assert.strictEqual(p.status, 'old_lead');
  assert.strictEqual(p.patch.custom_fields_values, undefined);
  assert.strictEqual(JSON.stringify(p.patch.tags_to_add), JSON.stringify([{ name: 'курс: Английский' }]));
});

test('без курса: в сделку ничего не пишем, запоминаем, новая ли переписка', () => {
  const fresh = directPatch_(
    { ts: '2026-09-26T20:53:05Z', course: '', ad_id: '' },
    { id: 38875423, created_at: unix('2026-09-26T20:53:01Z') }
  );
  assert.strictEqual(fresh.patch, null);
  assert.strictEqual(fresh.status, 'no_course');
  const old = directPatch_(
    { ts: '2026-09-26T20:24:00Z', course: '', ad_id: '' },
    { id: 38724005, created_at: unix('2026-09-20T10:00:00Z') }
  );
  assert.strictEqual(old.patch, null);
  assert.strictEqual(old.status, 'old_lead');
});

test('utm_campaign у новой сделки уже заполнен — не перезаписываем', () => {
  const p = directPatch_(
    { ts: '2026-09-26T15:20:05Z', course: 'Minecraft', ad_id: '' },
    { id: 5, created_at: unix('2026-09-26T15:20:01Z'), custom_fields_values: [{ field_id: 1648719, values: [{ value: 'Roblox' }] }] }
  );
  assert.strictEqual(p.status, 'has_value');
  assert.strictEqual(p.patch.custom_fields_values, undefined);
});

console.log('\nКто написал в Direct: таблица на странице');

const directRow_ = sandbox.pplDirectRow_;
const shortBot_ = sandbox.pplShortBot_;
const stagesMap = {
  7407214: { name: 'Регулярные занятия', statuses: { 81738178: 'Назначен ответственный', 142: 'Успешно реализовано', 143: 'Закрыто и не реализовано' } }
};

test('новая сделка: этап и воронка из справочника, не действующий клиент', () => {
  const r = directRow_(
    { ts: '2026-09-26T15:20:05Z', bot: 'CODDY®🚀 ШКОЛА ПРОГРАММИРОВАНИЯ', username: 'jane3dmp', name: 'Jane Mp', course: 'Minecraft', text: 'Minecraft: тест', status: 'ok' },
    { id: 38872981, pipeline_id: 7407214, status_id: 81738178, created_at: unix('2026-09-26T15:20:01Z') },
    stagesMap
  );
  assert.strictEqual(r.account, 'CODDY');
  assert.strictEqual(r.outcome, 'open');
  assert.strictEqual(r.pipeline, 'Регулярные занятия');
  assert.strictEqual(r.stage, 'Назначен ответственный');
  assert.strictEqual(r.client, false);
  assert.strictEqual(r.lead_id, 38872981);
});

test('отказ — с причиной; старая сделка — действующий клиент', () => {
  const lost = directRow_(
    { ts: '2026-09-26T15:20:05Z', bot: 'x', name: 'A', status: 'ok' },
    { id: 1, pipeline_id: 7407214, status_id: 143, created_at: unix('2026-09-26T15:20:01Z'), _embedded: { loss_reason: [{ id: 5, name: 'Дорого' }] } },
    stagesMap
  );
  assert.strictEqual(lost.outcome, 'lost');
  assert.strictEqual(lost.reason, 'Дорого');
  const client = directRow_(
    { ts: '2026-09-26T15:30:59Z', bot: 'ДЕТСКИЙ КЛУБ В МОГИЛЕВЕ', username: 'vaskovskaya_oksana', name: '', status: 'old_lead' },
    { id: 37034381, pipeline_id: 10365698, status_id: 81959114, created_at: unix('2026-05-14T06:18:00Z') },
    stagesMap
  );
  assert.strictEqual(client.client, true);
  assert.strictEqual(client.account, 'Детский клуб');
  assert.strictEqual(client.name, 'vaskovskaya_oksana', 'без имени профиля показываем ник');
  assert.strictEqual(client.stage, '', 'воронки нет в справочнике — этап пустой, не падаем');
});

test('сделки нет: пока retry — ищем, после попыток — не нашли', () => {
  assert.strictEqual(directRow_({ ts: '2026-09-26T15:20:05Z', status: 'retry' }, null, {}).outcome, 'wait');
  assert.strictEqual(directRow_({ ts: '2026-09-26T15:20:05Z', status: '' }, null, {}).outcome, 'wait');
  assert.strictEqual(directRow_({ ts: '2026-09-26T15:20:05Z', status: 'no_contact' }, null, {}).outcome, 'no_lead');
});

test('в таблицу: с курсом — всегда, без курса — только новая переписка и один раз', () => {
  const pick_ = sandbox.pplDirectPick_;
  const out = pick_([
    { contact_id: 'a', course: 'Minecraft', status: 'old_lead' },   // курс у старого контакта — показываем
    { contact_id: 'b', course: '', status: 'no_course' },           // отметка в сторис, новая сделка
    { contact_id: 'c', course: '', status: 'old_lead' },            // текущий разговор — нет
    { contact_id: 'd', course: '', status: 'retry' },               // сделку ещё ищем — пока нет
    { contact_id: 'e', course: '', status: 'no_course' },           // поздоровался…
    { contact_id: 'e', course: 'Глина', status: 'ok' }              // …и назвал курс — одна строка
  ]);
  assert.strictEqual(out.map(r => r.contact_id + ':' + (r.course || '-')).join(' '), 'a:Minecraft b:- e:Глина');
});

test('короткие имена аккаунтов', () => {
  assert.strictEqual(shortBot_('CODDY®🚀 ШКОЛА ПРОГРАММИРОВАНИЯ  И ДИЗАЙНА 🚀 МОГИЛЁВ'), 'CODDY');
  assert.strictEqual(shortBot_('ДЕТСКИЙ КЛУБ В МОГИЛЕВЕ'), 'Детский клуб');
  // так SendPulse прислал его 26.09.2026: «И» + знак краткой вместо «Й»
  assert.strictEqual(shortBot_('ДЕТСКИЙ КЛУБ В МОГИЛЕВЕ'), 'Детский клуб');
  assert.strictEqual(shortBot_('Детали: праздники'), 'Детали');
  assert.strictEqual(shortBot_('🎈 Новый аккаунт 🎈'), 'Новый аккаунт');
});

test('деньги — только у новой сделки, у действующего клиента их не приписываем', () => {
  const r = revenueCore_(
    [igLead({ lead_id: 1, created_at: '2026-09-26' }),
      igLead({ lead_id: 2, created_at: '2026-05-14', phone_e164: '+375291111111' })],
    [customer(101, '+375291102796'), customer(102, '+375291111111')],
    [pay(101, '27.09.2026', 300, 'p1'), pay(102, '27.09.2026', 90, 'p2')],
    '2026-09-01', '2026-09-30',
    [{ ts: '2026-09-26T15:20:05.000Z', lead_id: 1, client: false, outcome: 'won' },
      { ts: '2026-09-26T15:30:59.000Z', lead_id: 2, client: true, outcome: 'open' },
      { ts: '2026-09-26T16:00:00.000Z', lead_id: '', client: false, outcome: 'wait' }]
  );
  assert.strictEqual(r.direct.length, 3);
  assert.strictEqual(r.direct[0].with_alfa, true);
  assert.strictEqual(r.direct[0].revenue, 300);
  assert.strictEqual(r.direct[1].with_alfa, true);
  assert.strictEqual(r.direct[1].revenue, 0);
  assert.strictEqual(r.direct[2].with_alfa, false);
});

console.log('\nЛюди из Direct по объявлениям и расход по курсам');

const courseOf_ = sandbox.pplCourseOf_;
const adStats_ = sandbox.pplDirectAdStats_;
const courseSpend_ = sandbox.pplCourseSpend_;
const adsTotal_ = sandbox.pplAdsTotal_;
// названия как в кабинете 27.09.2026
const adSpend = {
  en1: { ad_name: '3-5 класс статика', campaign_name: 'сообщ английский набор 24,08', spend: 231, clicks: 655 },
  en2: { ad_name: 'видео', campaign_name: 'английский 1-2 класс сообщение', spend: 40, clicks: 90 },
  gl: { ad_name: 'видео', campaign_name: 'природная глина сообщение', spend: 155, clicks: 533 },
  cal: { ad_name: 'статика', campaign_name: 'каллиграфия сообщение', spend: 116, clicks: 374 },
  mco: { ad_name: 'видео', campaign_name: 'МЦО сообщение', spend: 113, clicks: 333 }
};
const dRow = (over) => Object.assign({ ad_id: '', course: '', lead_id: 1, client: false, revenue: 0 }, over);

test('курс объявления — по названию кампании, как курс сообщения', () => {
  assert.strictEqual(courseOf_('сообщ английский набор 24,08'), 'Английский');
  assert.strictEqual(courseOf_('природная глина сообщение'), 'Глина');
  assert.strictEqual(courseOf_('каллиграфия сообщение'), 'Каллиграфия');
  assert.strictEqual(courseOf_('МЦО сообщение'), '', 'нет в словаре — курс не определён');
  assert.strictEqual(courseOf_('Roblox и Blender: сколько?'), 'Roblox + 3D Blender', 'сочетания — как в приёмнике');
});

test('по курсу: одно объявление — цифры его, несколько — общая цифра курса', () => {
  const s = adStats_([
    dRow({ course: 'Английский', revenue: 300 }),
    dRow({ course: 'Глина', client: true }),
    dRow({ course: 'Глина', lead_id: '' }),
    dRow({ course: '' }),
    dRow({ course: 'Python' })
  ], adSpend);
  assert.strictEqual(s.mode, 'course');
  assert.strictEqual(s.byAd.gl.attr, 'course');
  assert.strictEqual(s.byAd.gl.wrote, 2);
  assert.strictEqual(s.byAd.gl.deals, 0, 'старая сделка и «ищем сделку» — не новые сделки');
  assert.strictEqual(s.byAd.en1.attr, 'shared');
  assert.strictEqual(s.byAd.en2.wrote, 1);
  assert.strictEqual(s.byAd.en1.revenue, 300);
  assert.strictEqual(s.byAd.cal, undefined);
  assert.strictEqual(s.courseOf.mco, '');
  assert.strictEqual(JSON.stringify(s.total), JSON.stringify({ wrote: 3, deals: 1, won: 1, revenue: 300, attr: '' }),
    'в итоге англичанин один раз, хоть у двух объявлений');
});

test('SendPulse передал ID объявления — считаем точно, по курсу не раскладываем', () => {
  const s = adStats_([
    dRow({ ad_id: 'gl', course: 'Глина', revenue: 90 }),
    dRow({ course: 'Английский' })
  ], adSpend);
  assert.strictEqual(s.mode, 'ad');
  assert.strictEqual(s.byAd.gl.attr, 'ad');
  assert.strictEqual(s.byAd.gl.revenue, 90);
  assert.strictEqual(s.byAd.en1, undefined, 'курс без ID — не реклама');
  assert.strictEqual(s.total.wrote, 1);
});

test('таблица объявлений: люди из Direct, CAC и ROAS — в валюте Альфы', () => {
  const s = adStats_([dRow({ course: 'Глина', revenue: 330 })], adSpend);
  const ads = aggregateByAd_([], adSpend, s, x => x * 3.3);
  const gl = ads.find(a => a.ad_id === 'gl');
  assert.strictEqual(gl.wrote, 1);
  assert.strictEqual(gl.won, 1);
  assert.strictEqual(gl.course, 'Глина');
  assert.strictEqual(gl.attr, 'course');
  assert.ok(Math.abs(gl.cac - 155 * 3.3) < 1e-9);
  assert.ok(Math.abs(gl.roas - 330 / (155 * 3.3)) < 1e-9);
  const mco = ads.find(a => a.ad_id === 'mco');
  assert.strictEqual(mco.wrote, 0);
  assert.strictEqual(mco.attr, '');
  const noFx = aggregateByAd_([], adSpend, s, () => null);
  assert.strictEqual(noFx.find(a => a.ad_id === 'gl').roas, null, 'нечем перевести валюту — не врём');
});

test('итог таблицы: общая цифра курса входит один раз', () => {
  const s = adStats_([dRow({ course: 'Английский', revenue: 300 })], adSpend);
  const ads = aggregateByAd_([], adSpend, s, x => x);
  const t = adsTotal_(ads, s, x => x);
  assert.strictEqual(t.wrote, 1);
  assert.strictEqual(t.revenue, 300);
  assert.strictEqual(t.spend, 231 + 40 + 155 + 116 + 113);
  assert.ok(Math.abs(t.roas - 300 / 655) < 1e-9);
});

test('расход по курсам: слитый бюджет виден, объявления без курса — в «не определён»', () => {
  const s = adStats_([], adSpend);
  const rows = courseSpend_(
    [{ course: 'Глина', leads: 2, with_alfa: 1, paid: 1, revenue: 330 },
      { course: '(курс не определён)', leads: 5, with_alfa: 0, paid: 0, revenue: 0 }],
    adSpend, s.courseOf, x => x * 3.3
  );
  const by = c => rows.find(r => r.course === c);
  assert.strictEqual(by('Глина').spend, 155);
  assert.ok(Math.abs(by('Глина').roas - 330 / (155 * 3.3)) < 1e-9);
  assert.strictEqual(by('Английский').spend, 271, 'оба объявления английского');
  assert.strictEqual(by('Английский').leads, 0);
  assert.strictEqual(by('Английский').cac, null);
  assert.strictEqual(by('Каллиграфия').spend, 116);
  assert.strictEqual(by('(курс не определён)').spend, 113, 'МЦО');
});

console.log('\nДосыпка Direct из истории SendPulse');

const backfillRows_ = sandbox.pplBackfillRows_;
const spTextHist_ = sandbox.pplSpText_;
const directCap_ = sandbox.pplDirectCap_;
const bfSince = Date.parse('2026-09-01T00:00:00+03:00');
const bfUntil = Date.parse('2026-09-27T09:43:00Z');
const msg = (iso, text, dir, extra) => Object.assign({ created_at: iso, direction: dir || 1, data: { text } }, extra);
const contact = { id: 'c1', channel_data: { user_name: 'anna', first_name: 'Анна', last_name: 'К' } };

test('история: первое за неделю, курс вторым сообщением — отдельной строкой', () => {
  const seen = {};
  const rows = backfillRows_(contact, [
    msg('2026-09-10T10:00:00Z', 'Здравствуйте'),
    msg('2026-09-10T10:00:30Z', 'Ответ бота', 2),
    msg('2026-09-10T10:01:00Z', 'Английский: сколько стоит?'),
    msg('2026-09-11T09:00:00Z', 'а в субботу есть?'),
    msg('2026-09-12T09:00:00Z', 'Английский ещё раз'),
    msg('2026-09-20T09:00:00Z', 'Снова пишу через 10 дней')
  ], 'Детский клуб', seen, bfSince, bfUntil);
  assert.strictEqual(rows.map(r => r[6] || '-').join(' '), '- Английский -');
  assert.strictEqual(rows[1][7], 'Английский', 'префикс кнопки');
  assert.strictEqual(rows[0][2], 'Детский клуб');
  assert.strictEqual(rows[0][4], 'anna');
  assert.strictEqual(rows[0][5], 'Анна К');
  assert.strictEqual(rows[0][11], '', 'статус пустой — строку разберёт задача меток');
});

test('история: вне окна и уже записанное приёмником не дублируется', () => {
  const seen = { c1: [{ t: Date.parse('2026-09-26T15:31:00Z'), course: 'Английский' }] };
  const rows = backfillRows_(contact, [
    msg('2026-08-31T20:00:00Z', 'Английский: август'),            // до 1 сентября по Минску
    msg('2026-09-25T10:00:00Z', 'Английский: расписание?'),        // приёмник записал его 26.09
    msg('2026-09-27T10:00:00Z', 'после включения приёмника')       // дальше пишет приёмник
  ], 'x', seen, bfSince, bfUntil);
  assert.strictEqual(rows.length, 0);
});

test('история: ID объявления из referral в data', () => {
  const rows = backfillRows_(contact, [msg('2026-09-15T10:00:00Z', 'Глина: пробное?', 1,
    { data: { text: 'Глина: пробное?', referral: { source: 'ADS', ad_id: '1202', ads_context_data: { ad_title: 'Глина' } } } })],
  'x', {}, bfSince, bfUntil);
  assert.strictEqual(rows[0][9], '1202');
  assert.strictEqual(rows[0][10], 'Глина');
});

test('текст сообщения из data SendPulse — строкой, text.body или глубже', () => {
  assert.strictEqual(spTextHist_({ text: ' Minecraft ' }), 'Minecraft');
  assert.strictEqual(spTextHist_({ text: { body: 'Roblox' } }), 'Roblox');
  assert.strictEqual(spTextHist_({ message: { text: 'Глина' } }), 'Глина');
  assert.strictEqual(spTextHist_({ attachments: [{ type: 'image' }] }), '');
});

test('страница получает последних N человек, итог — по всем', () => {
  const c = directCap_({ amo: 'https://x', rows: [{ ts: '2026-09-01' }, { ts: '2026-09-03' }, { ts: '2026-09-02' }] }, 2);
  assert.strictEqual(c.total, 3);
  assert.strictEqual(c.rows.map(r => r.ts).join(' '), '2026-09-03 2026-09-02');
  assert.strictEqual(c.amo, 'https://x');
});

test('без строк Direct ядро отдаёт пустой список, остальное не меняется', () => {
  const r = revenueCore_([igLead({})], [], [], '2026-07-01', '2026-07-31');
  assert.strictEqual(r.direct.length, 0);
  assert.strictEqual(r.leads, 1);
});

test('значение поля сделки читается по id, пустое — пустая строка', () => {
  const lead = { custom_fields_values: [{ field_id: 1648719, values: [{ value: ' Глина ' }] }] };
  assert.strictEqual(leadField_(lead, 1648719), 'Глина');
  assert.strictEqual(leadField_(lead, 1), '');
  assert.strictEqual(leadField_({}, 1648719), '');
});

/* ---------- пересбор RAW_pays порциями ---------- */

const payRow_ = sandbox.pplPayRow_;
const paysNextPos_ = sandbox.pplPaysNextPos_;
const paysCollect_ = sandbox.pplPaysCollect_;
const paysAssemble_ = sandbox.pplPaysAssemble_;
const briefBody_ = sandbox.pplBriefBody_;
// const верхнего уровня не попадает в sandbox, но видна следующему скрипту
const PAYS_MAX_PAGES = vm.runInContext('PPL_PAYS_MAX_PAGES', sandbox);

// Альфа в миниатюре: pay/index отдаёт страницы по 50
const alfaPay = (id, extra) => Object.assign({
  id, pay_type_id: 1, document_date: '08.09.2026', customer_id: 1000 + id,
  income: '25.5', pay_item_id: 3, payer_name: 'Плательщик ' + id
}, extra || {});
const payRange = (from, n) => Array.from({ length: n }, (_, i) => alfaPay(from + i));
const fakeAlfa = (byBranch) => (branch, page) =>
  ({ items: (byBranch[branch] || []).slice(page * 50, page * 50 + 50) });

/** Прежний пересбор одним проходом — эталон, с которым сверяем порции. */
function oneShotPays(branches, fetchPage) {
  const rows = [], seen = {};
  branches.forEach(branch => {
    for (let page = 0; page < 800; page++) {
      const items = fetchPage(branch, page).items || [];
      items.forEach(it => {
        if (it.pay_type_id !== 1) return;
        if (it.id && seen[it.id]) return;
        if (it.id) seen[it.id] = true;
        rows.push([it.document_date, it.customer_id, Number(it.income || 0), branch,
          it.pay_item_id || '', it.payer_name || '', it.id]);
      });
      if (items.length < 50) break;
    }
  });
  return rows;
}

/**
 * Пересбор так, как его пройдут запуски: каждому perRun страниц, следующий
 * продолжает с последней записанной страницы — как pplPaysStep_. killAt —
 * на каком вызове часов запуск «убивает» лимит времени.
 */
function runPays(branches, fetchPage, perRun, killAt) {
  const staged = [];
  let from = { b: 0, page: 0 };
  let runs = 0, errors = 0, clock = 0;
  while (from.b < branches.length && runs < 100) {
    runs++;
    let budget = perRun;
    const hasTime = () => {
      if (killAt && ++clock === killAt) throw new Error('Exceeded maximum execution time');
      return budget-- > 0;
    };
    try {
      if (paysCollect_(from, branches, fetchPage, hasTime, pages => staged.push(...pages)).error) errors++;
    } catch (e) { errors++; }
    const tail = staged[staged.length - 1];
    from = tail ? paysNextPos_(tail[0], tail[1], tail[2]) : { b: 0, page: 0 };
  }
  return { rows: paysAssemble_(staged), runs, errors };
}

// 1237 платежей — 25 страниц, из них полных 24; ровно 100 — две полные и
// пустая третья; зеркальный дубль и расход в четвёртом; пятый пуст
const paysBranches = ['1', '2', '4', '5'];
const paysData = {
  '1': payRange(1, 1237),
  '2': payRange(5001, 100),
  '4': [alfaPay(7), alfaPay(9001, { pay_type_id: 2 }), ...payRange(9002, 28)],
  '5': []
};

console.log('\nПересбор RAW_pays порциями');

test('порции дают ровно то же, что прежний сплошной проход', () => {
  const alfa = fakeAlfa(paysData);
  const expected = JSON.stringify(oneShotPays(paysBranches, alfa));
  [1, 7, 23, 1000].forEach(perRun => {
    let calls = 0;
    const out = runPays(paysBranches, (b, p) => { calls++; return alfa(b, p); }, perRun);
    assert.strictEqual(JSON.stringify(out.rows), expected, perRun + ' стр. за запуск');
    // дубли отсеял бы и дедуп, поэтому лишние скачивания ловим счётчиком
    assert.strictEqual(calls, 30, 'каждая страница скачана один раз');
  });
  assert.strictEqual(runPays(paysBranches, alfa, 7).runs, 5, '30 страниц по 7 — пять запусков');
  assert.strictEqual(runPays(paysBranches, alfa, 1000).runs, 1, 'хватило времени — один запуск');
  assert.strictEqual(JSON.parse(expected).length, 1237 + 100 + 28, 'дубль и расход отброшены');
});

test('сбой Альфы: следующий запуск начинает с той же страницы, ничего не теряется', () => {
  const alfa = fakeAlfa(paysData);
  let failed = false;
  const flaky = (branch, page) => {
    if (branch === '1' && page === 12 && !failed) { failed = true; throw new Error('Альфа pay/1: 400'); }
    return alfa(branch, page);
  };
  const out = runPays(paysBranches, flaky, 23);
  assert.strictEqual(out.errors, 1);
  assert.strictEqual(JSON.stringify(out.rows), JSON.stringify(oneShotPays(paysBranches, alfa)));
});

test('запуск, оборванный лимитом времени, теряет только незаписанные страницы', () => {
  const alfa = fakeAlfa(paysData);
  let calls = 0;
  // 23-й взгляд на часы: 20 страниц уже записаны, ещё 2 скачаны, но нет
  const out = runPays(paysBranches, (b, p) => { calls++; return alfa(b, p); }, 23, 23);
  assert.strictEqual(out.errors, 1);
  assert.strictEqual(calls, 32, 'перекачаны только две незаписанные страницы');
  assert.strictEqual(JSON.stringify(out.rows), JSON.stringify(oneShotPays(paysBranches, alfa)));
});

test('новый платёж посреди пересбора сдвигает страницы — дубль берётся один раз', () => {
  // Альфа отдаёт новые платежи первыми: пришедший между запусками
  // сдвигает остальные на одну позицию вниз
  const before = { '1': payRange(1, 120) };
  const after = { '1': [alfaPay(999), ...payRange(1, 120)] };
  let run = 0;
  const shifting = (branch, page) => fakeAlfa(run > 1 ? after : before)(branch, page);
  const staged = [];
  let from = { b: 0, page: 0 };
  while (from.b < 1 && run < 20) {
    run++;
    let budget = 1;
    paysCollect_(from, ['1'], shifting, () => budget-- > 0, pages => staged.push(...pages));
    const tail = staged[staged.length - 1];
    from = paysNextPos_(tail[0], tail[1], tail[2]);
  }
  const ids = paysAssemble_(staged).map(r => r[6]);
  assert.strictEqual(ids.length, 120, 'каждый прежний платёж — ровно один раз');
  assert.strictEqual(new Set(ids).size, 120);
  assert.ok(ids.indexOf(999) === -1, 'новый платёж был на уже скачанной странице — его добавит живая дельта и завтрашний пересбор');
});

test('следующая страница: полная — дальше по филиалу, неполная — следующий филиал', () => {
  const pos = (b, page, count) => JSON.stringify(paysNextPos_(b, page, count));
  assert.strictEqual(pos(0, 3, 50), '{"b":0,"page":4}');
  assert.strictEqual(pos(0, 3, 49), '{"b":1,"page":0}');
  assert.strictEqual(pos(1, 2, 0), '{"b":2,"page":0}', 'пустая страница после полной');
  assert.strictEqual(pos(0, PAYS_MAX_PAGES - 1, 50), '{"b":1,"page":0}', 'потолок страниц на филиал');
});

test('строка RAW_pays: те же колонки и типы, что писал прежний пересбор', () => {
  assert.strictEqual(JSON.stringify(payRow_(alfaPay(7), '1')),
    '["08.09.2026",1007,25.5,"1",3,"Плательщик 7",7]');
  assert.strictEqual(JSON.stringify(payRow_({ id: 9, pay_type_id: 1, document_date: '01.09.2026', customer_id: 5 }, '2')),
    '["01.09.2026",5,0,"2","","",9]', 'пустые поля — пустые строки, сумма — ноль');
  assert.strictEqual(payRow_(alfaPay(8, { pay_type_id: 2 }), '1'), null, 'расход не берём');
});

test('сборка из служебного листа: порядок скачивания, платёж из зеркала — один раз', () => {
  const rows = paysAssemble_([
    [0, 0, 2, JSON.stringify([['01.09.2026', 1, 10, '1', '', '', 11], ['01.09.2026', 2, 20, '1', '', '', 12]])],
    [1, 0, 0, '[]'],
    [2, 0, 2, JSON.stringify([['01.09.2026', 1, 10, '4', '', '', 11], ['02.09.2026', 3, 30, '4', '', '', 13]])]
  ]);
  assert.strictEqual(JSON.stringify(rows.map(r => r[6] + '@' + r[3])), '["11@1","12@1","13@4"]');
});

test('HTML-страница ошибки Альфы ужимается до заголовка и текста', () => {
  const html = '<!DOCTYPE html>\n<html lang="ru">\n    <head>\n        <meta charset="UTF-8">\n' +
    '        <title>Bad Request (#400)</title>\n<style>body { color: red }</style>\n    </head>\n' +
    '<body><h1>Bad Request (#400)</h1>\n<p>Неверные параметры запроса.</p><script>var x = 1;</script></body></html>';
  assert.strictEqual(briefBody_(html), 'Bad Request (#400): Bad Request (#400) Неверные параметры запроса.');
  assert.strictEqual(briefBody_('{"errors":["page"]}'), '{"errors":["page"]}', 'не HTML — как есть');
  assert.strictEqual(briefBody_(''), '');
});

/* ---------- webhook.gs: словарь курсов ---------- */

const hookBox = { console, LockService: {}, SpreadsheetApp: {}, PropertiesService: {}, ContentService: {} };
vm.createContext(hookBox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'webhook.gs'), 'utf8'),
  hookBox
);
const course_ = hookBox.spCourse_;
const prefix_ = hookBox.spPrefix_;
const spText_ = hookBox.spText_;

console.log('\nКурс из Direct: словарь');

test('кнопка из рекламы: курс в начале', () => {
  assert.strictEqual(course_('Лепка из природной глины: как записаться на пробное?'), 'Глина');
  assert.strictEqual(course_('Minecraft: сколько стоит курс?'), 'Minecraft');
  assert.strictEqual(course_('майнкрафт для 8 лет есть?'), 'Minecraft');
  assert.strictEqual(course_('Английский: какое расписание?'), 'Английский');
});

test('при нескольких курсах побеждает названный первым', () => {
  assert.strictEqual(course_('Scratch или Python — что лучше в 9 лет?'), 'Scratch');
});

test('частное раньше общего: «Нейромалыш», а не «Нейро»', () => {
  assert.strictEqual(course_('Нейромалыш: для кого подходит?'), 'Нейромалыш');
});

test('сочетания, заведённые в amoCRM отдельным курсом', () => {
  assert.strictEqual(course_('Roblox и Blender вместе можно?'), 'Roblox + 3D Blender');
  assert.strictEqual(course_('Blender + Unity: сколько длится?'), '3D Blender + Unity');
});

test('общий вопрос без курса — пусто', () => {
  assert.strictEqual(course_('Что подобрать для ребёнка 4-6 лет?'), '');
  assert.strictEqual(course_('Здравствуйте! Как записаться на пробное занятие?'), '');
  assert.strictEqual(course_(''), '');
});

test('«community» — не курс Unity', () => {
  assert.strictEqual(course_('Нашли вас через community родителей'), '');
});

test('префикс кнопки до двоеточия', () => {
  assert.strictEqual(prefix_('Лепка из природной глины: как записаться на пробное?'), 'Лепка из природной глины');
  assert.strictEqual(prefix_('Здравствуйте, расскажите про курсы'), '');
});

test('ID объявления ищется по всему событию SendPulse', () => {
  const ref = hookBox.spReferral_({
    info: { message: { channel_data: { message: { text: 'x', referral: {
      source: 'ADS', ad_id: '120211', ads_context_data: { ad_title: 'Глина' } } } } } }
  });
  assert.strictEqual(ref.ad_id, '120211');
  assert.strictEqual(ref.ad_title, 'Глина');
  assert.strictEqual(hookBox.spReferral_({ contact: { id: 1 } }).ad_id, undefined,
    'переписка не из рекламы — пусто');
});

test('текст сообщения SendPulse: из channel_data, иначе last_message', () => {
  assert.strictEqual(spText_({ info: { message: { channel_data: { message: { text: 'Minecraft: цена?' } } } } }), 'Minecraft: цена?');
  assert.strictEqual(spText_({ contact: { last_message: 'Глина: пробное?' } }), 'Глина: пробное?');
  assert.strictEqual(spText_({}), '');
});

test('словарь курсов в «ФБ» — точная копия словаря приёмника', () => {
  // people.gs и webhook.gs — разные проекты Apps Script, общего кода нет
  const dump = 'JSON.stringify([%C.map(c => [c[0], c[1].source, c[1].flags]), %K])';
  const ppl = vm.runInContext(dump.replace('%C', 'PPL_COURSES').replace('%K', 'PPL_COMBOS'), sandbox);
  const hook = vm.runInContext(dump.replace('%C', 'SP_COURSES').replace('%K', 'SP_COMBOS'), hookBox);
  assert.strictEqual(ppl, hook, 'курс добавили в один файл, а в другой — нет');
});

test('префикс и referral в досыпке — как в приёмнике', () => {
  ['Лепка из природной глины: как записаться?', 'Здравствуйте', 'a: b', ''].forEach(t =>
    assert.strictEqual(sandbox.pplPrefix_(t), hookBox.spPrefix_(t)));
  const ev = { info: { message: { channel_data: { message: { referral: { ad_id: '7', ads_context_data: { ad_title: 'T' } } } } } } };
  assert.strictEqual(JSON.stringify(sandbox.pplSpReferral_(ev)), JSON.stringify(hookBox.spReferral_(ev)));
});

test('один человек — одна строка за неделю, но строка с курсом важнее', () => {
  const seen_ = hookBox.spSeenRecently_;
  const now = Date.parse('2026-09-27T12:00:00Z');
  // [ts, service, bot, contact_id, username, name, course]
  const hi = ['2026-09-27T11:00:00Z', 'instagram', 'x', 'c1', 'u', 'n', ''];
  const mc = ['2026-09-27T11:05:00Z', 'instagram', 'x', 'c1', 'u', 'n', 'Minecraft'];
  const old = ['2026-09-10T11:00:00Z', 'instagram', 'x', 'c1', 'u', 'n', 'Minecraft'];
  assert.strictEqual(seen_([hi], 'c1', false, now), true, 'второе «Здравствуйте» — не новая строка');
  assert.strictEqual(seen_([hi], 'c1', true, now), false, 'курс вторым сообщением — строка пишется');
  assert.strictEqual(seen_([hi, mc], 'c1', true, now), true, 'курс уже записан');
  assert.strictEqual(seen_([old], 'c1', false, now), false, 'за окном — снова новый');
  assert.strictEqual(seen_([hi], 'c2', false, now), false, 'другой человек');
});

/* ---------- etl_amo.gs: повтор запросов к amoCRM ---------- */

// UrlFetch по сценарию: Error — сетевой сбой, число — код ответа
let amoScript = [], amoCalls = 0, amoSleeps = [];
const amoBox = {
  console,
  Logger: { log: () => {} },
  Utilities: { sleep: (ms) => { amoSleeps.push(ms); } },
  UrlFetchApp: {
    fetch: () => {
      amoCalls++;
      const step = amoScript.shift();
      if (step instanceof Error) throw step;
      const body = step === 200 ? '{"_embedded":{"leads":[{"id":1}]}}' : 'ответ ' + step;
      return { getResponseCode: () => step, getContentText: () => body };
    }
  },
  PropertiesService: {}, SpreadsheetApp: {}
};
vm.createContext(amoBox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'etl_amo.gs'), 'utf8'),
  amoBox
);
const amoCfg = { subdomain: 'demo', token: 't' };
function amoTry(script) {
  amoScript = script.slice(); amoCalls = 0; amoSleeps = [];
  try { return { data: amoBox.amoFetch_('/leads', amoCfg) }; } catch (e) { return { error: String(e.message || e) }; }
}

console.log('\nВыгрузка amoCRM: повтор при сбое');

test('сетевой сбой повторяется, вторая попытка проходит', () => {
  const out = amoTry([new Error('Address unavailable: https://demo.amocrm.ru/api/v4/leads'), 200]);
  assert.strictEqual(out.data._embedded.leads[0].id, 1);
  assert.strictEqual(amoCalls, 2);
  assert.strictEqual(JSON.stringify(amoSleeps), '[5000]');
});

test('три сбоя подряд — прогон падает с исходной ошибкой', () => {
  const down = new Error('Address unavailable: https://demo.amocrm.ru/api/v4/leads');
  const out = amoTry([down, down, down]);
  assert.ok(/Address unavailable/.test(out.error), out.error);
  assert.strictEqual(amoCalls, 3);
  assert.strictEqual(JSON.stringify(amoSleeps), '[5000,10000]');
});

test('5xx и 429 повторяются, дальше ответ разбирается как обычно', () => {
  assert.strictEqual(amoTry([502, 429, 200]).data._embedded.leads[0].id, 1);
  assert.strictEqual(amoCalls, 3);
  const out = amoTry([503, 503, 503]);
  assert.ok(/amoCRM 503/.test(out.error), out.error);
  assert.strictEqual(amoCalls, 3, 'больше трёх попыток не делаем');
});

test('401, 400 и 204 не повторяются — поведение прежнее', () => {
  assert.ok(/токен недействителен/.test(amoTry([401]).error));
  assert.strictEqual(amoCalls, 1);
  assert.ok(/amoCRM 400/.test(amoTry([400]).error));
  assert.strictEqual(amoCalls, 1);
  assert.strictEqual(amoTry([204]).data, null);
  assert.strictEqual(amoCalls, 1);
  assert.strictEqual(amoSleeps.length, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
