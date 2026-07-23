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

/* ---------- ядро выручки: мост по телефону ---------- */

const revenueCore_ = sandbox.pplAlfaRevenueCore_;

console.log('\nВыручка из Альфы: мост по телефону');

const igLead = (over) => Object.assign({
  created_at: '2026-07-10', phone_e164: '+375291102796', source: 'Instagram',
  pipeline: 'Каникулы', alfa_url: ''
}, over);
const customer = (id, phones) => ({ customer_id: id, branches: '4', phones: phones, amo_contact_id: '', created_at: '' });
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

test('даты-объекты из листа сравниваются с датой заявки правильно', () => {
  const r = revenueCore_(
    [igLead({ created_at: new Date(2026, 6, 10) })],
    [customer(101, '+375291102796')],
    [pay(101, new Date(2026, 6, 15), 250, 'p1')],
    '2026-07-01', '2026-07-31'
  );
  assert.strictEqual(r.revenue, 250);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
