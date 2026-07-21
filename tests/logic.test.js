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
  console
};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'people.gs'), 'utf8'),
  sandbox
);

const { joinClicksToLeads_, aggregateByAd_ } = sandbox;

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

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
